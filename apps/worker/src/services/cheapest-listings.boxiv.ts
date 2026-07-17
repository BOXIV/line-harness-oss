// BOXIV-only: 最安EVピックアップの日次更新。
//
// lightning.boxiv.co.jp（STUDIO/Nuxt）は掲載カードをクライアント側で CMS 購読するため
// 一覧HTMLに価格が乗らない。代わりに:
//   1. dynamic sitemap（car/detail 全件）から掲載URLを列挙
//   2. 各詳細ページの SSR ペイロード（__NUXT_DATA__）と OGP メタから
//      車名(og:title) / カバー画像(og:image) / 価格(数値文字列の最小値=車両本体) /
//      商談中・SOLD 判定 / 走行距離（説明文の「走行距離X,XXXkm」）を抽出
//   3. 販売中のみで安い順に3件 → D1 cheapest_listings、
//      Tesla かつ 300万円以下の台数 → market_stats.tesla_under_3m
//   4. friend-add-greeting テンプレ（carousel）の2枚目バブルを再生成して UPDATE
//
// 送信経路は静的テンプレのまま（友だち追加のたびに外部取得しない）。
// 失敗時は D1/テンプレを触らず Slack（#pj-lightning-lead 設定時のみ）へ警告。

import type { Env } from '../index.js';

const SITE = 'https://lightning.boxiv.co.jp';
const SITEMAP = `${SITE}/sitemap-dynamic/sitemap-dynamic-car-s-detail-s--c-slug.xml`;
const MAX_PAGES = 120;
const CONCURRENCY = 5;
const MIN_PRICE = 300000; // これ未満の数値文字列は価格とみなさない

type Listing = {
  listingId: string;
  title: string;
  price: number;
  mileageKm: number | null;
  url: string;
  imageUrl: string | null;
  negotiating: boolean;
};

function meta(html: string, name: string): string | null {
  const m = html.match(new RegExp(`(?:property|name)="${name}"[^>]*content="([^"]*)"`));
  return m ? m[1] : null;
}

function parseListing(url: string, html: string): Listing | null {
  const listingId = url.split('/').pop() ?? '';
  const rawTitle = meta(html, 'og:title');
  if (!rawTitle) return null;
  const title = rawTitle.replace(/\s*-\s*電気自動車のフリマ.*$/, '').replace(/ /g, ' ').trim();

  const nuxt = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!nuxt) return null;
  let payload: unknown[];
  try {
    payload = JSON.parse(nuxt[1]) as unknown[];
  } catch {
    return null;
  }
  const strs = payload.filter((x): x is string => typeof x === 'string');

  // 価格: "1,990,000" 形式の数値文字列群から抽出。ページには 本体価格/支払総額 の
  // ペア（差=諸費用 3万〜20万）に加え、頭金・値引き等の無関係な数値も含まれるため、
  // 「差が3万〜20万のペアの安い方 = 本体価格」を優先し、ペアが無ければ最大値を採用。
  const prices = [...new Set(
    strs
      .filter((s) => /^[\d,]{6,11}$/.test(s))
      .map((s) => Number(s.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n >= MIN_PRICE)
  )].sort((a, b) => a - b);
  if (prices.length === 0) return null;
  let price = prices[prices.length - 1];
  outer: for (const a of prices) {
    for (const b of prices) {
      if (b > a && b - a >= 30000 && b - a <= 200000) { price = a; break outer; }
    }
  }

  // ステータス判定: ペイロードには選択肢定義（商談中/成約済み 等）が全ページ共通で
  // 含まれるため文字列の有無では判定できない。定義ノード {key,name,...} の uid を集め、
  // コンテンツ側からその uid が「参照」されている場合のみ商談中/成約済みとみなす。
  const OPT_NAMES = new Set(['商談中', '成約済み', '成約済', 'SOLD', '売約済み', '売約済']);
  const optUidIdx = new Set<number>();
  for (const node of payload) {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const rec = node as Record<string, unknown>;
      if (typeof rec.key === 'number' && typeof rec.name === 'number') {
        const nm = payload[rec.name];
        if (typeof nm === 'string' && OPT_NAMES.has(nm.trim())) optUidIdx.add(rec.key);
      }
    }
  }
  let negotiating = false;
  if (optUidIdx.size > 0) {
    for (const node of payload) {
      if (negotiating) break;
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const rec = node as Record<string, unknown>;
        if (typeof rec.key === 'number' && typeof rec.name === 'number') continue; // 定義自身
        negotiating = Object.values(rec).some((v) => typeof v === 'number' && optUidIdx.has(v));
      } else if (Array.isArray(node) && node.length > 0 && node.every((v) => typeof v === 'number')) {
        negotiating = (node as number[]).some((v) => optUidIdx.has(v));
      }
    }
  }

  // 走行距離: 説明文の「走行距離48,946km」/「走行 2.1万km」など
  let mileageKm: number | null = null;
  const mkm = html.match(/走行距離\s*([\d,]+)\s*km/) ?? html.match(/([\d,]+)\s*km/);
  if (mkm) {
    const n = Number(mkm[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 100 && n < 500000) mileageKm = n;
  }

  return {
    listingId,
    title,
    price,
    mileageKm,
    url,
    imageUrl: meta(html, 'og:image'),
    negotiating,
  };
}

type CrawlState = {
  queue: string[];
  results: Listing[];
  startedAt: string;
};

async function loadState(env: Env['Bindings']): Promise<CrawlState | null> {
  const row = await env.DB.prepare("SELECT value FROM market_stats WHERE key = 'crawl_state'")
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const s = JSON.parse(row.value) as CrawlState;
    // 2時間より古い残骸は破棄（途中失敗のスタック防止）
    if (Date.now() - new Date(s.startedAt).getTime() > 2 * 60 * 60 * 1000) return null;
    return s;
  } catch {
    return null;
  }
}

async function saveState(env: Env['Bindings'], s: CrawlState | null): Promise<void> {
  if (s === null) {
    await env.DB.prepare("DELETE FROM market_stats WHERE key = 'crawl_state'").run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO market_stats (key, value, updated_at) VALUES ('crawl_state', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(JSON.stringify(s)).run();
}

// 1バッチ分（サブリクエスト上限50の内側に収める）だけ巡回して state を進める。
// queue が空になったら結果を返す（それまでは null）。
const BATCH = 40;

async function crawlStep(env: Env['Bindings'], init: boolean): Promise<Listing[] | null | 'noop'> {
  let state = await loadState(env);
  if (!state) {
    if (!init) return 'noop';
    const res = await fetch(SITEMAP, { headers: { 'User-Agent': 'boxiv-line-connect-cron/1.0' } });
    if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, MAX_PAGES);
    if (urls.length === 0) throw new Error('sitemap empty');
    state = { queue: urls, results: [], startedAt: new Date().toISOString() };
  }

  const chunkUrls = state.queue.slice(0, BATCH);
  state.queue = state.queue.slice(BATCH);
  for (let i = 0; i < chunkUrls.length; i += CONCURRENCY) {
    const chunk = chunkUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (u) => {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'boxiv-line-connect-cron/1.0' } });
          if (!r.ok) return null;
          return parseListing(u, await r.text());
        } catch {
          return null;
        }
      })
    );
    for (const l of results) if (l) state.results.push(l);
  }

  if (state.queue.length === 0) {
    await saveState(env, null);
    return state.results;
  }
  await saveState(env, state);
  return null; // 続きあり
}

function yen(n: number): string {
  return '¥' + n.toLocaleString('en-US');
}

function buildBubble2(env: Env['Bindings'], picks: Listing[], teslaUnder3m: number): unknown {
  const MEDIA = `${env.WORKER_URL || 'https://line-connect-test.boxiv.workers.dev'}/media/bubbles`;
  const rows: unknown[] = [
    { type: 'text', text: '現在最安のテスラを3台ご紹介', weight: 'bold', size: 'md', color: '#111111' },
  ];
  picks.forEach((p, i) => {
    if (i > 0) rows.push({ type: 'separator', margin: 'lg', color: '#E6E6EA' });
    const info: unknown[] = [
      { type: 'text', text: `${p.title} ›`, weight: 'bold', size: 'xs', color: '#111111', decoration: 'underline' },
      { type: 'text', text: yen(p.price), weight: 'bold', size: 'md', color: '#111111' },
    ];
    if (p.mileageKm) {
      info.push({
        type: 'text',
        text: `走行 ${(p.mileageKm / 10000).toFixed(1)}万km`,
        size: 'xxs',
        color: '#8A8A90',
      });
    }
    rows.push({
      type: 'box', layout: 'horizontal', spacing: 'md', margin: 'lg', alignItems: 'center',
      contents: [
        {
          // 角丸クリップ用ラッパー（flex image 自体は cornerRadius 不可）
          type: 'box', layout: 'vertical', cornerRadius: '10px', width: '100px', flex: 0,
          contents: [{
            type: 'image',
            url: p.imageUrl || `${MEDIA}/thumb-wide.jpg`,
            size: 'full', aspectRatio: '1200:630', aspectMode: 'cover',
          }],
        },
        {
          type: 'box', layout: 'vertical', spacing: 'xs', flex: 1,
          action: { type: 'uri', label: '掲載ページ', uri: p.url },
          contents: info,
        },
      ],
    });
  });
  rows.push({ type: 'filler', flex: 1 });
  rows.push({
    type: 'box', layout: 'vertical', backgroundColor: '#111111', cornerRadius: '999px',
    paddingAll: '12px', margin: 'xxl',
    action: { type: 'uri', label: '販売中のEV', uri: `${SITE}/` },
    contents: [
      { type: 'text', text: '販売中のEVをすべて見る', weight: 'bold', size: 'xs', color: '#FFFFFF', align: 'center' },
    ],
  });

  return {
    type: 'bubble', size: 'mega',
    body: {
      type: 'box', layout: 'vertical', paddingAll: '0px',
      contents: [
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          paddingStart: '20px', paddingEnd: '20px', paddingTop: '28px', paddingBottom: '28px',
          background: { type: 'linearGradient', angle: '180deg', startColor: '#5E6FFF', endColor: '#55D6FF' },
          contents: [
            { type: 'text', text: '今販売中のお得なEV', weight: 'bold', size: 'xl', color: '#FFFFFF' },
            { type: 'text', text: '中間マージンがないから、安く買える。', size: 'sm', color: '#FFFFFFE6', wrap: true },
            { type: 'separator', margin: 'md', color: '#FFFFFF61' },
            { type: 'text', text: '成約手数料', size: 'xxs', color: '#FFFFFFC7', margin: 'md' },
            { type: 'text', text: '固定 38,500円（税込）', weight: 'bold', size: 'md', color: '#FFFFFF' },
            { type: 'text', text: '300万円以下のテスラ', size: 'xxs', color: '#FFFFFFC7', margin: 'md' },
            { type: 'text', text: `いま ${teslaUnder3m}台 掲載中`, weight: 'bold', size: 'md', color: '#FFFFFF' },
          ],
        },
        { type: 'box', layout: 'vertical', paddingAll: '20px', flex: 1, contents: rows },
      ],
    },
  };
}

async function slackWarn(env: Env['Bindings'], text: string): Promise<void> {
  const token = env.DIAGNOSIS_SLACK_BOT_TOKEN || env.SELLENTRY_SLACK_BOT_TOKEN;
  const channel = env.DIAGNOSIS_SLACK_CHANNEL_ID;
  if (!token || !channel) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text: `⚠️ 最安EV日次更新: ${text}` }),
    });
  } catch (e) {
    console.error('cheapest-listings: slack warn failed', e);
  }
}

export async function refreshCheapestListings(
  env: Env['Bindings'],
  opts: { init?: boolean } = {}
): Promise<{
  ok: boolean;
  pending?: boolean;
  remaining?: number;
  picked?: { title: string; price: number; listingId: string }[];
  teslaUnder3m?: number;
  crawled?: number;
  error?: string;
}> {
  let listings: Listing[];
  try {
    const step = await crawlStep(env, opts.init ?? true);
    if (step === 'noop') return { ok: true, pending: false };
    if (step === null) {
      const st = await loadState(env);
      return { ok: true, pending: true, remaining: st?.queue.length ?? -1 };
    }
    listings = step;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await slackWarn(env, `クロール失敗（${msg}）。前回データを維持します。`);
    return { ok: false, error: msg };
  }

  const onSale = listings.filter((l) => !l.negotiating);
  const picks = [...onSale].sort((a, b) => a.price - b.price).slice(0, 3);
  const teslaUnder3m = onSale.filter((l) => /tesla/i.test(l.title) && l.price <= 3000000).length;

  // サニティ: 0件なら更新しない（古いデータのまま静観し警告）
  if (picks.length === 0) {
    await slackWarn(env, `販売中の掲載が0件でした（crawl ${listings.length}件）。更新をスキップ。`);
    return { ok: false, error: 'no listings', crawled: listings.length };
  }

  // D1 更新
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stmts = [
    env.DB.prepare('DELETE FROM cheapest_listings'),
    ...picks.map((p, i) =>
      env.DB.prepare(
        'INSERT INTO cheapest_listings (rank, listing_id, title, price, mileage_km, url, image_url, fetched_at) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(i + 1, p.listingId, p.title, p.price, p.mileageKm, p.url, p.imageUrl, now)
    ),
    env.DB.prepare(
      "INSERT INTO market_stats (key, value, updated_at) VALUES ('tesla_under_3m', ?, ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(String(teslaUnder3m), now),
  ];
  await env.DB.batch(stmts);

  // friend-add-greeting テンプレ（carousel）の2枚目を再生成
  const row = await env.DB.prepare('SELECT id, message_content FROM templates WHERE name = ?')
    .bind('friend-add-greeting')
    .first<{ id: string; message_content: string }>();
  if (row) {
    try {
      const carousel = JSON.parse(row.message_content) as { type: string; contents: unknown[] };
      if (carousel.type === 'carousel' && Array.isArray(carousel.contents) && carousel.contents.length >= 2) {
        carousel.contents[1] = buildBubble2(env, picks, teslaUnder3m);
        await env.DB.prepare("UPDATE templates SET message_content = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(carousel), row.id)
          .run();
      } else {
        await slackWarn(env, 'friend-add-greeting が carousel 形式でないためテンプレ更新をスキップ。');
      }
    } catch (e) {
      await slackWarn(env, 'テンプレJSONの更新に失敗（パースエラー）。D1のみ更新済み。');
      console.error('cheapest-listings: template update failed', e);
    }
  }

  return {
    ok: true,
    crawled: listings.length,
    teslaUnder3m,
    picked: picks.map((p) => ({ title: p.title, price: p.price, listingId: p.listingId })),
  };
}
