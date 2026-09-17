/**
 * follow webhook の「連携済み救済」経路を、実ハンドラ（POST /webhook）で固定する（BOXIV）。
 *
 * #106 の目的は「アプリ出品で LINE 連携したが、その時は友だち追加をスキップした人が、
 * 後から友だち追加したときに、一般の挨拶（friend_add）ではなく出品者向けの
 * 連携完了メッセージ（listing_link_completed）が届く」こと。
 * PR 時点のテストは台帳のサービス関数だけで、この経路そのものは実機でも未確認だった。
 *
 * ここでは LINE 署名つきの follow イベントを実際に Worker へ投げ、
 *   - どの automation が走ったか（automation_logs）
 *   - 何が push されたか（LINE API への fetch を記録）
 *   - 送信権フラグ（friends.metadata.listing_price_notified）
 * を見る。LINE / 外部 API はすべてスタブ（実キー・実通信なし）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { testDb } from './support/fixtures.js';
import { insertOrphanLink, upsertOnSubmit, markLinked } from '../src/services/listing-entry.boxiv.js';

// vitest.config.ts の bindings.LINE_CHANNEL_SECRET と同じ値（ダミー）。
const CHANNEL_SECRET = 'test-channel-secret';

const S03_TEXT = 'S03-売却価格のご提案';
const GREETING_TEXT = 'GREETING-友だち追加ありがとうございます';
const BUYER_TEXT = 'BUYER-購入エントリー完了';

const AUTOMATIONS = [
  { id: 'fra-auto-s03', event: 'listing_link_completed', text: S03_TEXT },
  { id: 'fra-auto-greet', event: 'friend_add', text: GREETING_TEXT },
  { id: 'fra-auto-buyer', event: 'buyer_link_completed', text: BUYER_TEXT },
];

/** push された本文の記録（テストごとに初期化）。 */
let pushed: string[] = [];
let pushShouldFail = false;

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function postFollow(lineUserId: string, opts: { isUnblocked?: boolean } = {}): Promise<void> {
  const body = JSON.stringify({
    events: [
      {
        type: 'follow',
        mode: 'active',
        timestamp: Date.now(),
        webhookEventId: `evt-${crypto.randomUUID()}`,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId: lineUserId },
        replyToken: 'dummy-reply-token',
        ...(opts.isUnblocked ? { follow: { isUnblocked: true } } : {}),
      },
    ],
  });
  const res = await SELF.fetch('https://worker.example.test/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': await sign(body) },
    body,
  });
  expect(res.status).toBe(200);
}

/** webhook は waitUntil で非同期処理するので、結果が出るまで D1 をポーリングする。 */
async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function automationRuns(friendId: string): Promise<Array<{ automation_id: string; status: string }>> {
  const res = await testDb
    .prepare(`SELECT automation_id, status FROM automation_logs WHERE friend_id = ? ORDER BY created_at ASC`)
    .bind(friendId)
    .all<{ automation_id: string; status: string }>();
  return res.results ?? [];
}

async function friendOf(lineUserId: string) {
  return testDb
    .prepare(
      `SELECT id, is_following,
              json_extract(metadata, '$.listing_price_notified') AS seller_notified,
              json_extract(metadata, '$.buyer_link_notified') AS buyer_notified
         FROM friends WHERE line_user_id = ?`,
    )
    .bind(lineUserId)
    .first<{ id: string; is_following: number; seller_notified: number | null; buyer_notified: number | null }>();
}

async function tagsOf(friendId: string): Promise<string[]> {
  const res = await testDb
    .prepare(`SELECT t.name FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id = ?`)
    .bind(friendId)
    .all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name);
}

/** link callback の共通前半（upsertFriend）相当。連携時に未フォローなら is_following=0 で friend ができている。 */
async function seedFriend(id: string, lineUserId: string, isFollowing: 0 | 1, metadata: Record<string, unknown> = {}): Promise<void> {
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO friends (id, line_user_id, display_name, is_following, metadata, created_at, updated_at)
       VALUES (?, ?, 'フォロー救済 テスト', ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(id, lineUserId, isFollowing, JSON.stringify(metadata))
    .run();
}

async function cleanupUser(friendId: string, lineUserId: string, matchKeys: string[]): Promise<void> {
  await testDb.prepare(`DELETE FROM automation_logs WHERE friend_id = ?`).bind(friendId).run();
  await testDb.prepare(`DELETE FROM messages_log WHERE friend_id = ?`).bind(friendId).run();
  await testDb.prepare(`DELETE FROM friend_tags WHERE friend_id = ?`).bind(friendId).run();
  await testDb.prepare(`DELETE FROM friends WHERE line_user_id = ?`).bind(lineUserId).run();
  for (const k of matchKeys) await testDb.prepare(`DELETE FROM listing_entries WHERE match_key = ?`).bind(k).run();
}

beforeAll(async () => {
  for (const a of AUTOMATIONS) {
    await testDb
      .prepare(
        `INSERT OR REPLACE INTO automations (id, name, event_type, conditions, actions, is_active, priority)
         VALUES (?, ?, ?, '{}', ?, 1, 0)`,
      )
      .bind(a.id, a.id, a.event, JSON.stringify([{ type: 'send_message', params: { messageType: 'text', content: a.text } }]))
      .run();
  }
});

beforeEach(() => {
  pushed = [];
  pushShouldFail = false;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('api.line.me') && url.includes('/message/push')) {
      if (pushShouldFail) return new Response('{"message":"boom"}', { status: 500 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ text?: string }> };
      for (const m of body.messages ?? []) pushed.push(m.text ?? '(non-text)');
      return new Response(JSON.stringify({ sentMessages: [{ id: `line-msg-${pushed.length}` }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('api.line.me') && url.includes('/bot/profile/')) {
      return new Response(JSON.stringify({ displayName: 'フォロー救済 テスト', userId: 'U-stub' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('follow webhook: アプリ出品で連携済み・連携時は未フォローだった人が後から友だち追加', () => {
  const FRIEND_ID = 'fra-friend-app-orphan';
  const LINE_USER_ID = 'Ufollowrescue0000000000000000001';
  const BOXIV_ID = 'FRATEST1';

  it('直連携（起票なし＝orphan 行）→ 出品者向け listing_link_completed が 1 通だけ届き、挨拶は届かない', async () => {
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    // 連携時点: friend は未フォローで登録、台帳は app_listing の連携済み行。イベントは保留（未送信）。
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0);
    await insertOrphanLink(testDb, BOXIV_ID, LINE_USER_ID, 'フォロー救済 テスト', 'seller', 'app_listing');
    try {
      await postFollow(LINE_USER_ID);
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-s03', status: 'success' }]);
      expect(pushed).toEqual([S03_TEXT]);

      const f = await friendOf(LINE_USER_ID);
      expect(f?.is_following).toBe(1);
      expect(f?.seller_notified).toBe(1);
      expect(f?.buyer_notified).toBeNull();
      expect(await tagsOf(FRIEND_ID)).toContain('出品者');
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    }
  });

  it('Portal の起票あり（submit → markLinked）でも同じく listing_link_completed が届く', async () => {
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0);
    await upsertOnSubmit(testDb, { matchKey: BOXIV_ID, formData: {}, flow: 'app_listing' });
    await markLinked(testDb, BOXIV_ID, LINE_USER_ID, 'フォロー救済 テスト');
    try {
      await postFollow(LINE_USER_ID);
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-s03', status: 'success' }]);
      expect(pushed).toEqual([S03_TEXT]);
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    }
  });

  it('連携時に callback が送信済み（フラグあり）なら、後続の follow では何も送らない（二重送信なし）', async () => {
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    // 連携時点でフォロー済み → callback が送って送信権フラグを立てた状態。
    await seedFriend(FRIEND_ID, LINE_USER_ID, 1, { listing_price_notified: true });
    await insertOrphanLink(testDb, BOXIV_ID, LINE_USER_ID, 'フォロー救済 テスト', 'seller', 'app_listing');
    try {
      await postFollow(LINE_USER_ID);
      // 連携済み分岐は 3 秒ホールドしないので、十分待ってから「何も起きていない」ことを見る。
      await new Promise((r) => setTimeout(r, 1500));
      expect(await automationRuns(FRIEND_ID)).toEqual([]);
      expect(pushed).toEqual([]);
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    }
  });

  it('送信済みの人のブロック解除（再フォロー）には挨拶を送る（価格お知らせは再送しない）', async () => {
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0, { listing_price_notified: true });
    await insertOrphanLink(testDb, BOXIV_ID, LINE_USER_ID, 'フォロー救済 テスト', 'seller', 'app_listing');
    try {
      await postFollow(LINE_USER_ID, { isUnblocked: true });
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-greet', status: 'success' }]);
      expect(pushed).toEqual([GREETING_TEXT]);
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    }
  });
});

describe('follow webhook: 対照群', () => {
  it('未連携の新規フォローには挨拶（friend_add）だけが届く', async () => {
    const LINE_USER_ID = 'Ufollowrescue0000000000000000002';
    const existing = await friendOf(LINE_USER_ID);
    if (existing) await cleanupUser(existing.id, LINE_USER_ID, []);
    try {
      await postFollow(LINE_USER_ID);
      // 未連携の新規フォローは 3 秒ホールドして再判定してから挨拶する。
      const f = await waitFor(async () => {
        const row = await friendOf(LINE_USER_ID);
        if (!row) return null;
        return (await automationRuns(row.id)).length > 0 ? row : null;
      });
      expect(await automationRuns(f.id)).toEqual([{ automation_id: 'fra-auto-greet', status: 'success' }]);
      expect(pushed).toEqual([GREETING_TEXT]);
      expect(f.seller_notified).toBeNull();
    } finally {
      const row = await friendOf(LINE_USER_ID);
      if (row) await cleanupUser(row.id, LINE_USER_ID, []);
    }
  });

  it('購入者として連携済みの人には buyer_link_completed（flow で種別が決まる）', async () => {
    const FRIEND_ID = 'fra-friend-buyer';
    const LINE_USER_ID = 'Ufollowrescue0000000000000000003';
    const MATCH_KEY = 'fra-buyer-match-key-0001';
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [MATCH_KEY]);
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0);
    await insertOrphanLink(testDb, MATCH_KEY, LINE_USER_ID, 'フォロー救済 テスト', 'buyer', 'buyer_form');
    try {
      await postFollow(LINE_USER_ID);
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-buyer', status: 'success' }]);
      expect(pushed).toEqual([BUYER_TEXT]);
      const f = await friendOf(LINE_USER_ID);
      expect(f?.buyer_notified).toBe(1);
      expect(f?.seller_notified).toBeNull();
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [MATCH_KEY]);
    }
  });

  it('925 とコード反映の隙間に入った行（flow=NULL）も source から種別を補って送る', async () => {
    const FRIEND_ID = 'fra-friend-nullflow';
    const LINE_USER_ID = 'Ufollowrescue0000000000000000004';
    const MATCH_KEY = 'fra-nullflow-match-key-0001';
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [MATCH_KEY]);
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0);
    await insertOrphanLink(testDb, MATCH_KEY, LINE_USER_ID, 'フォロー救済 テスト', 'seller', 'listing_form');
    await testDb.prepare(`UPDATE listing_entries SET flow = NULL WHERE match_key = ?`).bind(MATCH_KEY).run();
    try {
      await postFollow(LINE_USER_ID);
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-s03', status: 'success' }]);
      expect(pushed).toEqual([S03_TEXT]);
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [MATCH_KEY]);
    }
  });
});

describe('【既知の未対応: codex P2】送信に失敗しても送信権（claim）が解放されない', () => {
  const FRIEND_ID = 'fra-friend-pushfail';
  const LINE_USER_ID = 'Ufollowrescue0000000000000000005';
  const BOXIV_ID = 'FRATEST5';

  // fireEvent は action の失敗を throw しない（processAutomations が握って automation_logs に
  // 'failed' を残すだけ）。そのため呼び出し側の catch → unmarkLinkCompletedNotified は
  // 到達不能で、LINE 側の一時障害で push が落ちると、その人には連携完了メッセージが
  // 二度と送られない（次の follow では「送信済み」扱いになる）。
  // これは #106 が持ち込んだものではなく、Web 出品 / 購入者 / follow webhook の 3 経路に
  // 元からある作り（#106 は同じ作法を写した）。直したらこのテストの期待値を反転させること。
  it('push が 500 で落ちると automation は failed、しかしフラグは立ったまま残る（現状の挙動の固定）', async () => {
    await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    await seedFriend(FRIEND_ID, LINE_USER_ID, 0);
    await insertOrphanLink(testDb, BOXIV_ID, LINE_USER_ID, 'フォロー救済 テスト', 'seller', 'app_listing');
    pushShouldFail = true;
    try {
      await postFollow(LINE_USER_ID);
      const runs = await waitFor(async () => {
        const r = await automationRuns(FRIEND_ID);
        return r.length > 0 ? r : null;
      });
      expect(runs).toEqual([{ automation_id: 'fra-auto-s03', status: 'failed' }]);
      expect(pushed).toEqual([]);
      const f = await friendOf(LINE_USER_ID);
      // ← 本来は null（解放）であってほしい。現状は 1 のまま＝再送の機会が失われる。
      expect(f?.seller_notified).toBe(1);
    } finally {
      await cleanupUser(FRIEND_ID, LINE_USER_ID, [BOXIV_ID]);
    }
  });
});
