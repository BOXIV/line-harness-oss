/**
 * 台帳（listing_entries）の入口（flow）まわりの固定（BOXIV）。
 *
 * アプリ出品の match_key を `app:{boxivID}` にしていたため、Portal の起票
 * （/listing-form/submit は match_key に boxivID を使う）に markLinked が当たらず、
 * 起票行が form_only のまま残って催促 CRON が誤送信していた（TEST で実害を確認）。
 * match_key は boxivID に揃え、入口の識別は key の形ではなく flow 列に一本化した。
 *
 * ここで守るのは 2 点:
 *   - 起票と連携が同じ match_key で繋がること（= 催促の対象から外れること）
 *   - 送るイベントの種別が flow から 1 か所で決まること（LINK_COMPLETED_EVENT）
 */
import { describe, expect, it } from 'vitest';
import { testDb } from './support/fixtures.js';
import {
  LINK_COMPLETED_EVENT,
  resolveEntryFlow,
  upsertOnSubmit,
  markLinked,
  insertOrphanLink,
} from '../src/services/listing-entry.boxiv.js';

describe('resolveEntryFlow（flow が NULL の行は source から補う）', () => {
  it('flow が入っていればその値をそのまま使う', () => {
    expect(resolveEntryFlow({ flow: 'app_listing', source: 'seller' })).toBe('app_listing');
  });

  it('flow が NULL の購入者行は buyer_form', () => {
    expect(resolveEntryFlow({ flow: null, source: 'buyer' })).toBe('buyer_form');
  });

  it('flow が NULL の出品者行は listing_form', () => {
    expect(resolveEntryFlow({ flow: null, source: 'seller' })).toBe('listing_form');
  });
});

describe('LINK_COMPLETED_EVENT（入口 → 連携完了イベント種別）', () => {
  it('Web 出品とアプリ出品は同じ listing_link_completed（#68 で分けるまでの仮）', () => {
    expect(LINK_COMPLETED_EVENT.listing_form).toBe('listing_link_completed');
    expect(LINK_COMPLETED_EVENT.app_listing).toBe('listing_link_completed');
  });

  it('購入者は buyer_link_completed', () => {
    expect(LINK_COMPLETED_EVENT.buyer_form).toBe('buyer_link_completed');
  });
});

describe('アプリ出品の起票 → 連携（match_key = boxivID）', () => {
  // テスト専用の値。boxivID と同じ形（英大文字 + 数字 8 桁）にしてある。
  const BOXIV_ID = 'TESTBX01';
  const LINE_USER_ID = 'Uflowtest000000000000000000000001';

  async function cleanup(): Promise<void> {
    await testDb.prepare('DELETE FROM listing_entries WHERE match_key = ?').bind(BOXIV_ID).run();
  }

  it('Portal の起票行に markLinked が当たり、linked になっても flow は app_listing のまま', async () => {
    await cleanup();
    // Portal の /listing-form/submit 相当（boxiv_id 付き＝アプリ経由の起票）
    const submitted = await upsertOnSubmit(testDb, {
      matchKey: BOXIV_ID,
      formData: { 'お名前': 'フロー テスト' },
      flow: 'app_listing',
    });
    try {
      expect(submitted?.status).toBe('form_only');
      expect(submitted?.flow).toBe('app_listing');

      // アプリ出品の LINE 連携（app-listing.boxiv.ts の complete 相当）
      const linked = await markLinked(testDb, BOXIV_ID, LINE_USER_ID, 'フロー テスト');
      // null なら起票行に当たっていない＝旧 `app:` プレフィックスの不具合が戻っている
      expect(linked).not.toBeNull();
      expect(linked?.status).toBe('linked');
      expect(linked?.line_user_id).toBe(LINE_USER_ID);
      // 入口は起票時のまま（連携で書き換わらない）
      expect(linked?.flow).toBe('app_listing');

      // 催促 CRON は status='form_only' だけを拾うので、この行はもう対象外
      const remaining = await testDb
        .prepare(`SELECT COUNT(*) AS n FROM listing_entries WHERE match_key = ? AND status = 'form_only'`)
        .bind(BOXIV_ID)
        .first<{ n: number }>();
      expect(remaining?.n).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('insertOrphanLink の ON CONFLICT（既存の入口を上書きしない）', () => {
  const MATCH_KEY = 'TESTBX02';
  const LINE_USER_ID = 'Uflowtest000000000000000000000002';

  async function cleanup(): Promise<void> {
    await testDb.prepare('DELETE FROM listing_entries WHERE match_key = ?').bind(MATCH_KEY).run();
  }

  it('既に flow が入っている行は既存優先で残り、status だけ linked になる', async () => {
    await cleanup();
    await upsertOnSubmit(testDb, { matchKey: MATCH_KEY, formData: {}, flow: 'listing_form' });
    try {
      const row = await insertOrphanLink(testDb, MATCH_KEY, LINE_USER_ID, '孤児 テスト', 'seller', 'app_listing');
      // COALESCE(listing_entries.flow, excluded.flow) なので既存の listing_form が勝つ
      expect(row?.flow).toBe('listing_form');
      expect(row?.status).toBe('linked');
      expect(row?.line_user_id).toBe(LINE_USER_ID);
    } finally {
      await cleanup();
    }
  });
});
