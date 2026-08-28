/**
 * 「送る前に送信権を取る」claim 群の固定（BOXIV / 2026-08-29 監査）。
 *
 * 3 経路とも従来は check→send→mark で、
 *   - broadcast: 手動 /send と cron の同時実行で全フォロワーへ二重配信
 *   - listing_link_completed: OAuth コールバックと follow webhook が数秒差で競合し価格お知らせが 2 通（既知 H3）
 *   - 催促 cron: 送信後の markStepSent が D1 一時エラーで落ちると次 tick で同じ顧客へ再送
 * だった。いずれも条件付き UPDATE の changes で勝者を 1 つに決める。ここでは
 * 「2 回目の claim は必ず false」「戻せば再び取れる」を D1 上で確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  claimBroadcastForSending,
  createBroadcast,
  deleteBroadcast,
  getBroadcastById,
  updateBroadcastStatus,
  upsertFriend,
} from '@line-crm/db';
import { testDb } from './support/fixtures.js';
import {
  claimLinkCompletedNotified,
  unmarkLinkCompletedNotified,
  hasLinkCompletedNotified,
  claimReminderStep,
  recordReminderSent,
  hasRecentReminderToContact,
  upsertOnSubmit,
} from '../src/services/listing-entry.boxiv.js';

describe('claimBroadcastForSending', () => {
  it('draft は 1 回だけ取れ、2 回目は false（sending のまま）', async () => {
    const b = await createBroadcast(testDb, {
      title: 'claim-test',
      messageType: 'text',
      messageContent: 'hello',
      targetType: 'tag',
      targetTagId: null,
    });
    try {
      expect(await claimBroadcastForSending(testDb, b.id)).toBe(true);
      expect(await claimBroadcastForSending(testDb, b.id)).toBe(false);
      expect((await getBroadcastById(testDb, b.id))?.status).toBe('sending');
      // 失敗時に draft へ戻せば再び取れる
      await updateBroadcastStatus(testDb, b.id, 'draft');
      expect(await claimBroadcastForSending(testDb, b.id)).toBe(true);
      // sent になったら取れない
      await updateBroadcastStatus(testDb, b.id, 'sent');
      expect(await claimBroadcastForSending(testDb, b.id)).toBe(false);
    } finally {
      await deleteBroadcast(testDb, b.id);
    }
  });

  it('存在しない id は false', async () => {
    expect(await claimBroadcastForSending(testDb, 'no-such-broadcast')).toBe(false);
  });
});

describe('claimLinkCompletedNotified（friend.metadata のフラグ）', () => {
  it('seller / buyer は別フラグで、それぞれ 1 回だけ取れる', async () => {
    const friend = await upsertFriend(testDb, {
      lineUserId: 'Uclaimtest0000000000000000000000001',
      displayName: 'claim テスト',
    });
    try {
      await unmarkLinkCompletedNotified(testDb, friend.id, 'seller');
      await unmarkLinkCompletedNotified(testDb, friend.id, 'buyer');

      expect(await claimLinkCompletedNotified(testDb, friend.id, 'seller')).toBe(true);
      expect(await claimLinkCompletedNotified(testDb, friend.id, 'seller')).toBe(false);
      expect(await hasLinkCompletedNotified(testDb, friend.id, 'seller')).toBe(true);
      // buyer は独立
      expect(await hasLinkCompletedNotified(testDb, friend.id, 'buyer')).toBe(false);
      expect(await claimLinkCompletedNotified(testDb, friend.id, 'buyer')).toBe(true);
      expect(await claimLinkCompletedNotified(testDb, friend.id, 'buyer')).toBe(false);
      // 送信失敗で戻せば再び取れる
      await unmarkLinkCompletedNotified(testDb, friend.id, 'seller');
      expect(await hasLinkCompletedNotified(testDb, friend.id, 'seller')).toBe(false);
      expect(await claimLinkCompletedNotified(testDb, friend.id, 'seller')).toBe(true);
    } finally {
      await testDb.prepare('DELETE FROM friends WHERE id = ?').bind(friend.id).run();
    }
  });

  it('存在しない friend は false', async () => {
    expect(await claimLinkCompletedNotified(testDb, 'no-such-friend', 'seller')).toBe(false);
  });
});

describe('催促 cron の claim と連絡先リレー抑止', () => {
  const A = 'claim-reminder-a';
  const B = 'claim-reminder-b';
  const EMAIL = 'claim-reminder@example.test';

  async function cleanup(): Promise<void> {
    await testDb.prepare('DELETE FROM listing_entries WHERE match_key IN (?, ?)').bind(A, B).run();
  }

  it('claimReminderStep は expected が一致するときだけ 1 回進む', async () => {
    await cleanup();
    await upsertOnSubmit(testDb, { matchKey: A, formData: {}, email: EMAIL });
    try {
      expect(await claimReminderStep(testDb, A, 0)).toBe(true);
      // 同じ expected（=別 tick が同じ行を再取得した状況）は取れない
      expect(await claimReminderStep(testDb, A, 0)).toBe(false);
      expect(await claimReminderStep(testDb, A, 1)).toBe(true);
      const row = await testDb
        .prepare('SELECT reminder_count FROM listing_entries WHERE match_key = ?')
        .bind(A)
        .first<{ reminder_count: number }>();
      expect(row?.reminder_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('hasRecentReminderToContact は別 match_key の同じ連絡先への直近送信だけを見る', async () => {
    await cleanup();
    await upsertOnSubmit(testDb, { matchKey: A, formData: {}, email: EMAIL, phone: '09012345678' });
    await upsertOnSubmit(testDb, { matchKey: B, formData: {}, email: EMAIL, phone: '09012345678' });
    try {
      // まだどこにも送っていない
      expect(await hasRecentReminderToContact(testDb, { email: EMAIL, phone: null, excludeMatchKey: B, withinHours: 24 })).toBe(false);
      // A に送った記録
      await recordReminderSent(testDb, A, { email: true, sms: false });
      // B から見ると「同じメールへ直近送信あり」
      expect(await hasRecentReminderToContact(testDb, { email: EMAIL, phone: null, excludeMatchKey: B, withinHours: 24 })).toBe(true);
      // A 自身は除外される（自分の送信で自分を止めない）
      expect(await hasRecentReminderToContact(testDb, { email: EMAIL, phone: null, excludeMatchKey: A, withinHours: 24 })).toBe(false);
      // SMS 側はまだ送っていない
      expect(await hasRecentReminderToContact(testDb, { email: null, phone: '09012345678', excludeMatchKey: B, withinHours: 24 })).toBe(false);
      await recordReminderSent(testDb, A, { email: false, sms: true });
      expect(await hasRecentReminderToContact(testDb, { email: null, phone: '09012345678', excludeMatchKey: B, withinHours: 24 })).toBe(true);
      // 連絡先が両方 null なら常に false
      expect(await hasRecentReminderToContact(testDb, { email: null, phone: null, excludeMatchKey: B, withinHours: 24 })).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
