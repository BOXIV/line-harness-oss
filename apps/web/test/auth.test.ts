/**
 * 認証まわりの純粋関数（BOXIV）。
 *
 * `safeNextPath` は「セッション切れ → ログイン → 元の画面へ戻る」の戻り先を検証する。
 * ここが緩いと、正規ドメインで本物のログインを終えた直後に偽の
 * 「セッションが切れました」へ着地させられる（フィッシングの説得力が上がる）。
 * `?next=` 付きリンクは auth-guard / handleUnauthorized が普段から生成する形なので、
 * 細工リンクが自然に見えるのが厄介。
 */
import { describe, expect, it } from 'vitest'
import { safeNextPath } from '../src/lib/auth'

const ORIGIN = 'https://line-connect-admin.pages.dev'

describe('safeNextPath', () => {
  it('同一オリジンのパスはそのまま返す（正当な戻り先を壊さない）', () => {
    expect(safeNextPath('/chats?tab=seller#x', ORIGIN)).toBe('/chats?tab=seller#x')
    expect(safeNextPath('/staff-availability', ORIGIN)).toBe('/staff-availability')
    expect(safeNextPath(`${ORIGIN}/friends`, ORIGIN)).toBe('/friends')
  })

  it('プロトコル相対 URL を弾く', () => {
    expect(safeNextPath('//evil.com', ORIGIN)).toBeNull()
  })

  it('バックスラッシュ経由の外部 URL を弾く', () => {
    // new URL('/\\evil.com', origin).href === 'https://evil.com/'
    expect(safeNextPath('/\\evil.com', ORIGIN)).toBeNull()
  })

  it('自オリジンを前置してプロトコル相対にする細工を弾く', () => {
    // origin 検査は通るが pathname が // で始まり、router.push に渡すと外部へ飛ぶ。
    // 文字列判定（startsWith('//')）から URL 解決へ変えたときに開いた穴。
    expect(safeNextPath(`${ORIGIN}//evil.com`, ORIGIN)).toBeNull()
    expect(safeNextPath(`${ORIGIN}/\\/evil.com`, ORIGIN)).toBeNull()
    expect(safeNextPath(`${ORIGIN}///evil.com`, ORIGIN)).toBeNull()
  })

  it('別オリジンの絶対 URL を弾く', () => {
    expect(safeNextPath('https://evil.com/x', ORIGIN)).toBeNull()
    expect(safeNextPath('http://line-connect-admin.pages.dev/x', ORIGIN)).toBeNull()
  })

  it('空 / 壊れた値は null', () => {
    expect(safeNextPath(null, ORIGIN)).toBeNull()
    expect(safeNextPath('', ORIGIN)).toBeNull()
  })
})
