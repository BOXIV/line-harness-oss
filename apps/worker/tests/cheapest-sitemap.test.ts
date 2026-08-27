// 最安EVクロールの入口（sitemap 解決）のユニットテスト。
//
// 2026-08-24、STUDIO が動的 sitemap のファイル名を
//   sitemap-dynamic-car-s-detail-s--c-slug.xml
//   → sitemap-dynamic-<base64url("car/detail/:slug")>.xml
// に変えた。ファイル名を焼き込んでいたので 404 になり、友だち追加あいさつの
// 「現在最安のテスラ3台」が3日間 8/23 のデータのまま（1台は既に商談中）だった。
//
// ここで固定する要件:
//   1. 入口は sitemap index だけ。子 sitemap のファイル名に依存しない
//   2. 同じCMSコレクションを配信する garage/detail・car/detail/test を拾わない
//   3. 命名規則がまた変わっても、中身の URL で当てられる
//   4. 当てられないときは黙って0件にせず、index に何があったかを添えて throw する

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDetailUrls } from '../src/services/cheapest-listings.boxiv.js';

const SITE = 'https://lightning.boxiv.co.jp';
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dyn = (name: string) => `${SITE}/sitemap-dynamic/sitemap-dynamic-${name}.xml`;

const index = (children: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex>${children
    .map((c) => `<sitemap><loc>${c}</loc></sitemap>`)
    .join('')}</sitemapindex>`;
const urlset = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

/** URL → 本文 の対応表で fetch を差し替える。表に無い URL は 404。 */
function stubFetch(pages: Record<string, string | number>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = pages[url];
    if (typeof hit === 'number') return new Response('', { status: hit });
    if (hit === undefined) return new Response('not found', { status: 404 });
    return new Response(hit, { status: 200 });
  });
  return calls;
}

const CAR = [`${SITE}/car/detail/20043`, `${SITE}/car/detail/10512`];
const GARAGE = [`${SITE}/garage/detail/20043`, `${SITE}/garage/detail/10512`];
const CAR_TEST = [`${SITE}/car/detail/test/20043`, `${SITE}/car/detail/test/10512`];

afterEach(() => vi.unstubAllGlobals());

describe('fetchDetailUrls', () => {
  it('sitemap index から base64url 名の car/detail sitemap を引き当てる', async () => {
    const carSm = dyn(b64url('car/detail/:slug'));
    const calls = stubFetch({
      [`${SITE}/sitemap.xml`]: index([`${SITE}/sitemap-static.xml`, carSm]),
      [carSm]: urlset(CAR),
    });
    await expect(fetchDetailUrls()).resolves.toEqual(CAR);
    // 名前で一発で当てるので、子 sitemap は 1 本しか取りに行かない（サブリクエスト節約）
    expect(calls).toEqual([`${SITE}/sitemap.xml`, carSm]);
  });

  it('garage/detail と car/detail/test を拾わない（同じ掲載が3ルートで配信される）', async () => {
    const carSm = dyn(b64url('car/detail/:slug'));
    const garageSm = dyn(b64url('garage/detail/:slug'));
    const testSm = dyn(b64url('car/detail/test/:slug'));
    const calls = stubFetch({
      // index 上の並びは garage / test が先。名前一致が優先されることを確かめる
      [`${SITE}/sitemap.xml`]: index([garageSm, testSm, carSm]),
      [garageSm]: urlset(GARAGE),
      [testSm]: urlset(CAR_TEST),
      [carSm]: urlset(CAR),
    });
    await expect(fetchDetailUrls()).resolves.toEqual(CAR);
    // 名前一致を先に見るので、外れの2本は取りに行かない。
    // ここが崩れると 1 tick のサブリクエストが増え、40ページ巡回と合わせて上限に近づく。
    expect(calls).toEqual([`${SITE}/sitemap.xml`, carSm]);
  });

  it('命名規則がまた変わっても中身の URL で当てられる', async () => {
    // base64 として読めない名前（＝将来の第3の命名規則）でも死なない
    const a = dyn('zzz-unknown-scheme-1');
    const b = dyn('zzz-unknown-scheme-2');
    stubFetch({
      [`${SITE}/sitemap.xml`]: index([a, b]),
      [a]: urlset(GARAGE), // 一致0件なので次へ
      [b]: urlset([...CAR, ...CAR_TEST]),
    });
    // test ルートは混ざっていても除外される
    await expect(fetchDetailUrls()).resolves.toEqual(CAR);
  });

  it('index が落ちていたら HTTP ステータス付きで失敗する', async () => {
    stubFetch({ [`${SITE}/sitemap.xml`]: 503 });
    await expect(fetchDetailUrls()).rejects.toThrow(/sitemap index fetch failed: 503/);
  });

  it('car/detail が見つからなければ index の中身を添えて失敗する（黙って0件にしない）', async () => {
    const garageSm = dyn(b64url('garage/detail/:slug'));
    stubFetch({
      [`${SITE}/sitemap.xml`]: index([`${SITE}/sitemap-static.xml`, garageSm]),
      [garageSm]: urlset(GARAGE),
    });
    // 「何を見て諦めたか」が Slack 警告に出ないと、次に名前が変わったとき同じ調査をやり直す羽目になる
    await expect(fetchDetailUrls()).rejects.toThrow(/garage\/detail\/:slug/);
  });
});
