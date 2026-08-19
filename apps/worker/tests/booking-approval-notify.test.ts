// 撮影予約 承認後処理（Notion 自動入力 + スタッフメール通知）のユニットテスト。
//
// 検証する運用要件:
//   1. Notion 障害でも承認 API は 200 のまま（route レベル）・メールは送られる
//   2. スタッフのメール未設定は Slack 通報される（静かに落ちない）
//   3. 二重承認でメールが二重に飛ばない（notify_dedupe claim）
//   4. SendGrid 失敗時は claim が解放され、再承認で送り直せる + Slack 通報
//   5. Notion の既存ナンバー値（フル表記）を下4桁で潰さない
//
// テストデータに実在の電話番号・メールアドレスを使わないこと（PII 規律）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  notifyBookingApprovedFollowups,
  type BookingApprovalNotifyEnv,
} from '../src/services/booking-approval-notify.boxiv.js';
import { bookingRequests } from '../src/routes/booking-requests.js';

// ─── FakeD1: このテストで通る SQL だけを解釈する最小スタブ ───────────────

type Row = Record<string, unknown>;

class FakeD1 {
  bookings = new Map<string, Row>();
  slots = new Map<string, Row>();
  staff = new Map<string, Row>();
  friends = new Map<string, Row>();
  dedupe = new Map<string, number>(); // dedupe_key -> created_at

  prepare(sql: string) {
    const exec = (params: unknown[]) => this.#exec(sql, params);
    const make = (params: unknown[]) => ({
      first: async () => exec(params).row ?? null,
      run: async () => ({ meta: { changes: exec(params).changes ?? 0 } }),
      all: async () => ({ results: [] as Row[] }),
      bind: (...p: unknown[]) => make(p),
    });
    return make([]);
  }

  #exec(sql: string, params: unknown[]): { row?: Row | undefined; changes?: number } {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM booking_requests WHERE id = ?'))
      return { row: this.bookings.get(String(params[0])) };
    if (s.startsWith('SELECT * FROM staff_availability WHERE id = ?'))
      return { row: this.slots.get(String(params[0])) };
    if (s.startsWith('SELECT * FROM staff_members WHERE id = ?'))
      return { row: this.staff.get(String(params[0])) };
    if (s.startsWith('SELECT * FROM friends WHERE id = ?'))
      return { row: this.friends.get(String(params[0])) };
    if (s.startsWith('INSERT INTO notify_dedupe')) {
      // claimNotifyDedupe の条件付き UPSERT と同じ意味論
      const [key, now, windowMs] = params as [string, number, number];
      const existing = this.dedupe.get(key);
      if (existing === undefined || existing <= now - windowMs) {
        this.dedupe.set(key, now);
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    if (s.startsWith('DELETE FROM notify_dedupe WHERE dedupe_key')) {
      const existed = this.dedupe.delete(String(params[0]));
      return { changes: existed ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM notify_dedupe WHERE created_at')) return { changes: 0 };
    if (s.startsWith('UPDATE booking_requests')) {
      // approveBookingRequest / updateBookingRequest（WHERE id = ? が末尾）
      const id = String(params[params.length - 1]);
      const b = this.bookings.get(id);
      if (b && s.includes("status = 'approved'")) b.status = 'approved';
      return { changes: b ? 1 : 0 };
    }
    throw new Error(`FakeD1: unhandled SQL: ${s}`);
  }
}

// ─── fetch モック: Notion / Slack / SendGrid ────────────────────────────

interface FetchLog {
  notionGets: string[];
  notionPatches: Array<{ pageId: string; properties: Record<string, unknown> }>;
  slackAlerts: string[];
  sendgridBodies: Array<Record<string, unknown>>;
}

interface FetchBehavior {
  notionGetStatus?: number;
  notionPatchStatus?: number;
  notionProperties?: Record<string, unknown>;
  sendgridStatus?: number;
}

function installFetchMock(behavior: FetchBehavior = {}): FetchLog {
  const log: FetchLog = { notionGets: [], notionPatches: [], slackAlerts: [], sendgridBodies: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://api.notion.com/v1/pages/')) {
        const pageId = url.split('/pages/')[1];
        if (method === 'GET') {
          log.notionGets.push(pageId);
          const status = behavior.notionGetStatus ?? 200;
          if (status !== 200) return new Response('notion down', { status });
          return Response.json({ properties: behavior.notionProperties ?? {} });
        }
        if (method === 'PATCH') {
          const body = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
          log.notionPatches.push({ pageId, properties: body.properties });
          const status = behavior.notionPatchStatus ?? 200;
          if (status !== 200) return new Response('notion down', { status });
          return Response.json({ id: pageId });
        }
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        const body = JSON.parse(String(init?.body)) as { text?: string };
        log.slackAlerts.push(body.text ?? '');
        return Response.json({ ok: true });
      }
      if (url === 'https://api.sendgrid.com/v3/mail/send') {
        log.sendgridBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const status = behavior.sendgridStatus ?? 202;
        return new Response(status === 202 ? null : 'sendgrid error', { status });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return log;
}

// ─── フィクスチャ ────────────────────────────────────────────────────────

const BOOKING_ID = 'bk-1';
const SLOT_ID = 'slot-1';
const STAFF_ID = 'staff-1';
const PAGE_ID = 'page-1';

function makeDb(overrides: { booking?: Row; staff?: Row } = {}): FakeD1 {
  const db = new FakeD1();
  db.bookings.set(BOOKING_ID, {
    id: BOOKING_ID,
    friend_id: null,
    staff_id: STAFF_ID,
    invite_token: 'tok',
    notion_page_id: PAGE_ID,
    customer_name: 'テスト太郎',
    prefecture: '東京都',
    area: 'shutoken',
    vehicle_info: JSON.stringify({ raw: 'Model Y (vehicle_info)', phone: '090-0000-0000' }),
    slot_id: SLOT_ID,
    selected_candidate: null,
    plate_number: '1234',
    status: 'approved',
    notes: null,
    metadata: null,
    ...overrides.booking,
  });
  db.slots.set(SLOT_ID, {
    id: SLOT_ID,
    staff_id: STAFF_ID,
    date: '2026-09-01',
    start_time: '10:00',
    end_time: '12:00',
    area: 'shutoken',
    is_booked: 1,
  });
  db.staff.set(STAFF_ID, {
    id: STAFF_ID,
    name: '撮影 花子',
    email: 'staff@example.com',
    role: 'staff',
    api_key: 'lh_test',
    is_active: 1,
    ...overrides.staff,
  });
  return db;
}

function makeEnv(db: FakeD1): BookingApprovalNotifyEnv {
  return {
    DB: db as unknown as D1Database,
    NOTION_API_KEY: 'test-notion-key',
    SENDGRID_API_KEY: 'SG.test',
    SENDGRID_FROM_EMAIL: 'no-reply@example.com',
    CHAT_ALERT_SLACK_BOT_TOKEN: 'xoxb-test',
    CHAT_ALERT_SLACK_CHANNEL_ID: 'C000TEST',
  };
}

const NOTION_PROPS = {
  '[Form]車種名': { type: 'select', select: { name: 'Model 3' } },
  '[Form]電話番号': { type: 'phone_number', phone_number: '090-0000-0000' },
  '[LINE]ナンバー下4桁': { type: 'rich_text', rich_text: [] },
};

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── サービス単体 ────────────────────────────────────────────────────────

describe('notifyBookingApprovedFollowups', () => {
  it('正常系: Notion の2プロパティを更新し、スタッフへメールを1通送る', async () => {
    const log = installFetchMock({ notionProperties: NOTION_PROPS });
    const db = makeDb();
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);

    expect(result.notion).toBe('updated');
    expect(result.email).toBe('sent');
    expect(result.alerts).toBe(0);
    expect(log.slackAlerts).toHaveLength(0);

    // Notion PATCH: 撮影予定日は既存データと同じ「開始時刻あり +09:00・終了なし」形式
    expect(log.notionPatches).toHaveLength(1);
    const props = log.notionPatches[0].properties;
    expect(props['撮影予定日']).toEqual({ date: { start: '2026-09-01T10:00:00+09:00' } });
    expect(props['[LINE]ナンバー下4桁']).toEqual({
      rich_text: [{ type: 'text', text: { content: '1234' } }],
    });

    // メール: 4必須項目（日時/車種/ナンバー/電話）が本文に含まれる
    expect(log.sendgridBodies).toHaveLength(1);
    const mail = log.sendgridBodies[0] as {
      personalizations: Array<{ to: Array<{ email: string }> }>;
      content: Array<{ value: string }>;
      subject: string;
    };
    expect(mail.personalizations[0].to[0].email).toBe('staff@example.com');
    const text = mail.content[0].value;
    expect(text).toContain('2026年9月1日');
    expect(text).toContain('10:00 〜 12:00');
    expect(text).toContain('Model 3');
    expect(text).toContain('1234');
    expect(text).toContain('090-0000-0000');
    // 迷惑メール報告 → SendGrid 抑制リスト → ログインメール巻き添え を防ぐ注意書き（⚠️ 始まり）
    expect(text).toContain('⚠️ このメールを迷惑メール報告しないでください');
  });

  it('Notion 障害時: throw せず Slack 通報し、メールは vehicle_info フォールバックで送る', async () => {
    const log = installFetchMock({ notionGetStatus: 500 });
    const db = makeDb();
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);

    expect(result.notion).toBe('failed');
    expect(result.email).toBe('sent');
    expect(log.slackAlerts.some((t) => t.includes('自動入力に失敗'))).toBe(true);
    // Notion が読めなくても booking.vehicle_info から車種・電話を補完してメールは出す
    const text = (log.sendgridBodies[0] as { content: Array<{ value: string }> }).content[0].value;
    expect(text).toContain('Model Y (vehicle_info)');
    expect(text).toContain('090-0000-0000');
    // Slack 通報に電話番号を載せない（PII）
    for (const alertText of log.slackAlerts) {
      expect(alertText).not.toContain('090-0000-0000');
    }
  });

  it('Notion ページ未解決: Slack 通報し、メールは送る', async () => {
    const log = installFetchMock();
    const db = makeDb({ booking: { notion_page_id: null, friend_id: null } });
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);

    expect(result.notion).toBe('skipped_no_page');
    expect(log.notionPatches).toHaveLength(0);
    expect(log.slackAlerts.some((t) => t.includes('手動入力'))).toBe(true);
    expect(result.email).toBe('sent');
  });

  it('friends.metadata の notionLinks.seller からページを解決できる（buyer は使わない）', async () => {
    const log = installFetchMock({ notionProperties: NOTION_PROPS });
    const db = makeDb({ booking: { notion_page_id: null, friend_id: 'fr-1' } });
    db.friends.set('fr-1', {
      id: 'fr-1',
      metadata: JSON.stringify({
        notionLinks: {
          seller: { source: 'seller', pageId: 'seller-page', linkedAt: 'x' },
          buyer: { source: 'buyer', pageId: 'buyer-page', linkedAt: 'x' },
        },
        notion: { source: 'buyer', pageId: 'buyer-page', linkedAt: 'x' },
      }),
    });
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);
    expect(result.notion).toBe('updated');
    expect(log.notionPatches[0].pageId).toBe('seller-page');
  });

  it('スタッフのメール未設定: メールを送らず Slack 通報する', async () => {
    const log = installFetchMock({ notionProperties: NOTION_PROPS });
    const db = makeDb({ staff: { email: null } });
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);

    expect(result.email).toBe('skipped_no_email');
    expect(log.sendgridBodies).toHaveLength(0);
    expect(log.slackAlerts.some((t) => t.includes('メールアドレスが未設定'))).toBe(true);
    // Notion 側の更新は影響を受けない
    expect(result.notion).toBe('updated');
  });

  it('二重承認: 2回呼んでもメールは1通だけ', async () => {
    const log = installFetchMock({ notionProperties: NOTION_PROPS });
    const db = makeDb();
    const env = makeEnv(db);

    const r1 = await notifyBookingApprovedFollowups(env, BOOKING_ID);
    const r2 = await notifyBookingApprovedFollowups(env, BOOKING_ID);

    expect(r1.email).toBe('sent');
    expect(r2.email).toBe('deduped');
    expect(log.sendgridBodies).toHaveLength(1);
  });

  it('SendGrid 失敗: Slack 通報し claim を解放（次の承認で送り直せる）', async () => {
    const log = installFetchMock({ notionProperties: NOTION_PROPS, sendgridStatus: 500 });
    const db = makeDb();
    const env = makeEnv(db);

    const r1 = await notifyBookingApprovedFollowups(env, BOOKING_ID);
    expect(r1.email).toBe('failed');
    expect(log.slackAlerts.some((t) => t.includes('メール送信に失敗'))).toBe(true);

    // SendGrid 復旧後の再承認では改めて送られる（claim が解放されている）
    installFetchMock({ notionProperties: NOTION_PROPS });
    const log2 = installFetchMock({ notionProperties: NOTION_PROPS });
    const r2 = await notifyBookingApprovedFollowups(env, BOOKING_ID);
    expect(r2.email).toBe('sent');
    expect(log2.sendgridBodies).toHaveLength(1);
  });

  it('Notion 既存ナンバーがフル表記（下4桁を含む）なら潰さない', async () => {
    const log = installFetchMock({
      notionProperties: {
        ...NOTION_PROPS,
        '[LINE]ナンバー下4桁': {
          type: 'rich_text',
          rich_text: [{ plain_text: '品川300あ1234' }],
        },
      },
    });
    const db = makeDb();
    const result = await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);

    expect(result.notion).toBe('updated');
    const props = log.notionPatches[0].properties;
    expect(props['撮影予定日']).toBeDefined();
    expect(props['[LINE]ナンバー下4桁']).toBeUndefined();
  });

  it('approved 以外のステータスでは何もしない（並行キャンセルとの競合ガード）', async () => {
    const log = installFetchMock();
    const db = makeDb({ booking: { status: 'cancelled' } });
    await notifyBookingApprovedFollowups(makeEnv(db), BOOKING_ID);
    expect(log.notionPatches).toHaveLength(0);
    expect(log.sendgridBodies).toHaveLength(0);
  });
});

// ─── route レベル: 後処理が失敗しても承認 API は 200 ─────────────────────

describe('PUT /api/booking-requests/:id/approve', () => {
  function makeApp() {
    const app = new Hono<{ Variables: { staff: unknown } }>();
    app.use('*', async (c, next) => {
      c.set('staff', { id: STAFF_ID, role: 'admin', name: '管理者' });
      await next();
    });
    app.route('/', bookingRequests);
    return app;
  }

  it('Notion / SendGrid が全滅していても承認は 200 を返す', async () => {
    installFetchMock({ notionGetStatus: 500, sendgridStatus: 500 });
    const db = makeDb({ booking: { status: 'pending' } });
    const env = { ...makeEnv(db) };

    const waited: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException: () => {},
    };

    const res = await makeApp().request(
      `/api/booking-requests/${BOOKING_ID}/approve`,
      { method: 'PUT' },
      env,
      executionCtx as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // waitUntil に渡した後処理が reject しない（＝ waitUntil 経由でリクエストを汚さない）
    await expect(Promise.all(waited)).resolves.toBeDefined();
  });
});
