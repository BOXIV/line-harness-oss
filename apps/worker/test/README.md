# Worker テスト（BOXIV）

`@cloudflare/vitest-pool-workers` で実際の workers ランタイム + ローカル D1 に対して
Worker を丸ごと起動し、`SELF.fetch()` で HTTP を叩く。

```bash
pnpm --filter worker test        # 1 回実行（デプロイ前ゲートと同じ）
pnpm --filter worker test:watch  # 監視
```

## なにを守っているか

**ロール × エンドポイントの到達性**。これは「あるべき認可」ではなく **現在の挙動**
を固定する特性テスト（characterization test）で、認可の変更が特定ロールを
静かに締め出すことを検出するためにある。

2026-08-15、`/api/friends/count` に `requireRole('owner','admin','manager')` を
足した。管理画面のログインはこのエンドポイントで API キーを検証していたため、
撮影スタッフ（role=staff）5 名が「APIキーが正しくありません」で 3 日間ログイン
できなくなった。あの 1 行は `test/role-matrix.test.ts` があれば赤で止まっていた。

## 認可を意図的に変えるとき

1. **先に** `test/role-matrix.test.ts` の表を書き換える（期待値と `why` を更新）
2. そのあと実装を変える

実装を先に変えて、赤くなった期待値を後追いで合わせるのは禁止。それをやると
この表は「実装のコピー」に退化し、締め出しを検出できなくなる。

## 構成

| ファイル | 役割 |
| --- | --- |
| `role-matrix.test.ts` | ロール × エンドポイントの到達性マトリクス |
| `auth-middleware.test.ts` | 認証ミドルウェア（Bearer / env API_KEY / 在籍判定 / 認証スキップ一覧） |
| `support/schema.ts` | `packages/db/schema.sql` + 全 migration をテスト D1 へ適用 |
| `support/fixtures.ts` | owner/admin/manager/staff + 無効化済みの 5 行を seed、リクエストヘルパー |
| `support/setup.ts` | 各テストファイルの `beforeAll` でスキーマ適用 + seed |

テストで使うキーは全てダミー（`lh_0000…0001` 等）。本番・test 環境の実キーや
実スタッフのメールアドレスは一切含めない。

## デプロイ前ゲート

`apps/worker/scripts/deploy-boxiv.mjs` と `deploy-boxiv-test.mjs` は
wrangler.toml を swap する前に `vitest run` を実行し、失敗したらデプロイしない。
`.github/workflows/deploy-worker.yml`（upstream 用の別経路）にも同じステップを置いている。

緊急時にゲートを外す手段は「deploy スクリプトの `runWorkerTests()` 呼び出しを消す」だけ。
環境変数によるバイパスは意図的に用意していない。
