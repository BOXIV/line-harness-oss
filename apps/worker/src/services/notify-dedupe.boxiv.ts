// BOXIV-only: 通知経路の冪等化（クライアント二重送信の吸収）。
//
// /buyer-form/lead は催促 cron の誤発火を避けるため D1 台帳（listing_entries）に書かない設計で、
// 二重送信の吸収を Notion の重複判定（掲載ID＋人物）だけに頼っていた。だがそれは「行が増えない」
// だけで、Slack 通知は毎 POST 飛ぶ（実障害 2026-08-18: 値下げ依頼 2 件がどちらも 2 連投。
// Worker ログ上は同一端末からの独立した POST ×2、間隔 1.3s / 4.8s）。
// ここで「内容ハッシュ + 短時間ウィンドウ」の claim を D1 に置き、同一内容の 2 回目以降を
// ルート先頭で成功扱いのまま打ち切る。migration: 921_notify_dedupe.sql

export const LEAD_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** ウィンドウを大きく超えた行の掃除しきい値（claim のついでに消す。テーブルを育てない） */
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** 経路プレフィックス + 正規化ペイロードから dedupe_key を作る（SHA-256 hex）。 */
export async function buildDedupeKey(prefix: string, payload: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}:${hex}`;
}

/**
 * dedupe_key を claim する。true = 初回（処理を続行してよい）。
 * false = windowMs 以内に同一キーが claim 済み（= 二重送信。呼び出し側は成功応答のまま打ち切る）。
 * ウィンドウを過ぎた既存キーは created_at を貼り替えて再 claim できる（正当な再送を止めない）。
 * 判定は INSERT の条件付き UPSERT 1 文で行い、並行 POST でも claim できるのは 1 リクエストだけ。
 */
export async function claimNotifyDedupe(
  db: D1Database,
  key: string,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO notify_dedupe (dedupe_key, created_at) VALUES (?1, ?2)
       ON CONFLICT(dedupe_key) DO UPDATE SET created_at = excluded.created_at
       WHERE notify_dedupe.created_at <= ?2 - ?3`,
    )
    .bind(key, now, windowMs)
    .run();
  const claimed = (res.meta?.changes ?? 0) > 0;
  if (claimed) {
    // 掃除はベストエフォート。呼び出し頻度の低い経路なので claim 成功時に毎回で足りる。
    await db
      .prepare(`DELETE FROM notify_dedupe WHERE created_at < ?1`)
      .bind(now - PURGE_AFTER_MS)
      .run()
      .catch(() => {});
  }
  return claimed;
}

/**
 * claim を解放する。claim 後の必須処理（Notion 起票）が失敗してエラー応答を返すときに呼び、
 * クライアント/利用者の再送まで冪等化で握り潰さないようにする。
 */
export async function releaseNotifyDedupe(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM notify_dedupe WHERE dedupe_key = ?1`).bind(key).run();
}
