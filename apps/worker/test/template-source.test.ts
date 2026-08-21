/**
 * テンプレートの区分（出品者向け / 購入者向け / 共通・migration 922）。
 *
 * ここで固定するのは 2 つ:
 *
 *  1. `?source=` の絞り込みと、作成/更新時の値の検証。
 *     不正な値を黙って 'common' に落とすと、出品者向けのつもりのテンプレが
 *     共通タブに紛れ、間違った相手へ送る材料になる。だから 400 で弾く。
 *
 *  2. **タブで絞った状態からの並び替えが、絞り込みの外を壊さないこと。**
 *     一覧が部分集合になったのに丸ごと 1..n を振ると、送られてこなかった
 *     カテゴリは末尾（999999）へ飛び、同カテゴリの他 source のテンプレは
 *     古い序数のまま重複して並びが不定になる。タブ導入で初めて起きる壊れ方で、
 *     画面上は「並び替えたら関係ないカテゴリの順序が全部変わった」に見える。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requestAs, testDb } from './support/fixtures.js';

interface SeedTemplate {
  id: string;
  name: string;
  category: string;
  source: 'seller' | 'buyer' | 'common';
  sortOrder?: number;
}

async function seedTemplates(rows: SeedTemplate[]): Promise<void> {
  for (const r of rows) {
    await testDb
      .prepare(
        `INSERT INTO templates (id, name, category, message_type, message_content, sort_order, source, created_at, updated_at)
         VALUES (?, ?, ?, 'text', ?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
      )
      .bind(r.id, r.name, r.category, `${r.name} の本文`, r.sortOrder ?? 0, r.source)
      .run();
  }
}

async function seedCategoryOrder(names: string[]): Promise<void> {
  for (const [i, name] of names.entries()) {
    await testDb
      .prepare(
        `INSERT INTO template_categories (id, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')
         ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order`,
      )
      .bind(`cat-${name}`, name, i + 1)
      .run();
  }
}

async function listTemplates(query = ''): Promise<{ id: string; name: string; source: string; category: string }[]> {
  const res = await requestAs('owner', `/api/templates${query}`);
  expect(res.status).toBe(200);
  return (await res.json<{ data: { id: string; name: string; source: string; category: string }[] }>()).data;
}

async function listCategories(query = ''): Promise<string[]> {
  const res = await requestAs('owner', `/api/template-categories${query}`);
  expect(res.status).toBe(200);
  const body = await res.json<{ data: { name: string }[] }>();
  return body.data.map((c) => c.name);
}

beforeEach(async () => {
  await testDb.prepare('DELETE FROM templates').run();
  await testDb.prepare('DELETE FROM template_categories').run();
});

describe('区分での絞り込み', () => {
  beforeEach(async () => {
    await seedCategoryOrder(['s-price', 'b-entry', 'shared']);
    await seedTemplates([
      { id: 't-s1', name: '価格の提案', category: 's-price', source: 'seller', sortOrder: 1 },
      { id: 't-s2', name: '価格のリマインド', category: 's-price', source: 'seller', sortOrder: 2 },
      { id: 't-b1', name: '購入エントリー御礼', category: 'b-entry', source: 'buyer', sortOrder: 1 },
      { id: 't-c1', name: '友だち追加の挨拶', category: 'shared', source: 'common', sortOrder: 1 },
    ]);
  });

  it('source 未指定は全件返す', async () => {
    expect((await listTemplates()).map((t) => t.id)).toEqual(['t-s1', 't-s2', 't-b1', 't-c1']);
  });

  it('source ごとに絞り込める', async () => {
    expect((await listTemplates('?source=seller')).map((t) => t.id)).toEqual(['t-s1', 't-s2']);
    expect((await listTemplates('?source=buyer')).map((t) => t.id)).toEqual(['t-b1']);
    expect((await listTemplates('?source=common')).map((t) => t.id)).toEqual(['t-c1']);
  });

  it('未知の source は 500 にせず全件にフォールバックする', async () => {
    expect((await listTemplates('?source=unknown')).length).toBe(4);
  });

  it('category と source は AND で効く', async () => {
    expect((await listTemplates('?category=s-price&source=buyer')).length).toBe(0);
    expect((await listTemplates('?category=s-price&source=seller')).length).toBe(2);
  });

  it('カテゴリ一覧もタブの中に実在するものだけを返す', async () => {
    expect(await listCategories()).toEqual(['s-price', 'b-entry', 'shared']);
    expect(await listCategories('?source=seller')).toEqual(['s-price']);
    expect(await listCategories('?source=buyer')).toEqual(['b-entry']);
  });
});

describe('作成・更新時の区分', () => {
  it('省略すると共通になる', async () => {
    const res = await requestAs('owner', '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: '区分なし', category: 'x', messageType: 'text', messageContent: 'body' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<{ data: { source: string } }>()).data.source).toBe('common');
  });

  it('指定した区分で作成される', async () => {
    const res = await requestAs('owner', '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: '出品者向け', category: 'x', messageType: 'text', messageContent: 'body', source: 'seller' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<{ data: { source: string } }>()).data.source).toBe('seller');
  });

  it('不正な区分は 400 で弾く（黙って common に落とさない）', async () => {
    const res = await requestAs('owner', '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: '不正', category: 'x', messageType: 'text', messageContent: 'body', source: 'agent' }),
    });
    expect(res.status).toBe(400);
    expect((await listTemplates()).length).toBe(0);
  });

  it('更新で区分を変えられる / 不正値は 400', async () => {
    await seedTemplates([{ id: 't-1', name: '移動する', category: 'x', source: 'common' }]);

    const ng = await requestAs('owner', '/api/templates/t-1', {
      method: 'PUT',
      body: JSON.stringify({ source: 'seller-ish' }),
    });
    expect(ng.status).toBe(400);

    const ok = await requestAs('owner', '/api/templates/t-1', {
      method: 'PUT',
      body: JSON.stringify({ source: 'buyer' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ data: { source: string } }>()).data.source).toBe('buyer');
  });
});

describe('タブで絞った状態からの並び替え', () => {
  it('カテゴリ順: 送られてこなかったカテゴリは動かない', async () => {
    // 表示順 A(出品者) → B(購入者) → C(出品者)。出品者タブには A と C だけが見えている。
    await seedCategoryOrder(['A', 'B', 'C']);
    await seedTemplates([
      { id: 'a1', name: 'a1', category: 'A', source: 'seller' },
      { id: 'b1', name: 'b1', category: 'B', source: 'buyer' },
      { id: 'c1', name: 'c1', category: 'C', source: 'seller' },
    ]);

    // 出品者タブで C を A の前へ。送るのは ['C','A'] という部分集合。
    const res = await requestAs('owner', '/api/template-categories/reorder?source=seller', {
      method: 'PUT',
      body: JSON.stringify({ names: ['C', 'A'] }),
    });
    expect(res.status).toBe(200);
    // 出品者が占めていた 1・3 番目のスロットに C・A が入り、B は 2 番目のまま。
    expect(await listCategories()).toEqual(['C', 'B', 'A']);
    // レスポンスは呼び出し元のタブに合わせた並び。
    expect((await res.json<{ data: { name: string }[] }>()).data.map((c) => c.name)).toEqual(['C', 'A']);
  });

  it('カテゴリ順: 全件を送れば従来どおりその並びになる', async () => {
    await seedCategoryOrder(['A', 'B', 'C']);
    await seedTemplates([
      { id: 'a1', name: 'a1', category: 'A', source: 'seller' },
      { id: 'b1', name: 'b1', category: 'B', source: 'buyer' },
      { id: 'c1', name: 'c1', category: 'C', source: 'seller' },
    ]);

    const res = await requestAs('owner', '/api/template-categories/reorder', {
      method: 'PUT',
      body: JSON.stringify({ names: ['C', 'B', 'A'] }),
    });
    expect(res.status).toBe(200);
    expect(await listCategories()).toEqual(['C', 'B', 'A']);
  });

  it('テンプレ順: 同カテゴリに残る別区分の行が押し出されない', async () => {
    // 1 つのカテゴリに 出品者・購入者・出品者 が混在。出品者タブでは t1 と t3 だけ見えている。
    await seedCategoryOrder(['mix']);
    await seedTemplates([
      { id: 't1', name: 't1', category: 'mix', source: 'seller', sortOrder: 1 },
      { id: 't2', name: 't2', category: 'mix', source: 'buyer', sortOrder: 2 },
      { id: 't3', name: 't3', category: 'mix', source: 'seller', sortOrder: 3 },
    ]);

    const res = await requestAs('owner', '/api/templates/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ids: ['t3', 't1'] }),
    });
    expect(res.status).toBe(200);

    // 出品者の 1・3 番目のスロットが t3・t1 に入れ替わり、t2 は 2 番目のまま。
    expect((await listTemplates('?category=mix')).map((t) => t.id)).toEqual(['t3', 't2', 't1']);
    // 序数が重複していない（重複すると表示順が created_at 依存で揺れる）。
    const orders = (await testDb.prepare('SELECT sort_order FROM templates WHERE category = ?')
      .bind('mix').all<{ sort_order: number }>()).results.map((r) => r.sort_order).sort();
    expect(orders).toEqual([1, 2, 3]);
  });
});
