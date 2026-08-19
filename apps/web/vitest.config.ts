import { defineConfig } from 'vitest/config'

/**
 * Admin 管理画面の純粋関数テスト（BOXIV）。
 *
 * ここは DOM もブラウザ API も必要としないものだけを置く（node 環境）。
 * 画面そのものの検証は Playwright で test 環境に対して行う。
 *
 * 置いている理由: 認証の戻り先検証（safeNextPath）のように「文字列の判定を1文字
 * 間違えると外部サイトへ飛ばせる」種類のロジックが web 側にもあるため。
 * 実際 safeNextPath は 2 回続けて穴が開いた（文字列判定 → URL 解決 → 権限部の再解釈）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
