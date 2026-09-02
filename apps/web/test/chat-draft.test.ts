/**
 * 下書き（送信相手ごとに貯めておく文面）を入力欄で扱うときの純粋関数（BOXIV）。
 *
 * 肝は trackUsedDraft。送信に成功したら挿入元の下書きを消す仕様なので、
 * 「入力欄を空にして別の文面を書き始めた」ときに追跡が残っていると、
 * **送っていない下書きが消える**。そこだけは取り違えないよう固定する。
 */
import { describe, expect, it } from 'vitest'
import { draftAuthorLabel, draftPreview, trackUsedDraft } from '../src/lib/chat-draft'

describe('trackUsedDraft', () => {
  it('挿入した下書きを編集している間は追跡が続く', () => {
    expect(trackUsedDraft('draft-1', '明日の10時はいかがでしょうか')).toBe('draft-1')
    expect(trackUsedDraft('draft-1', '明日の14時に変更しました')).toBe('draft-1')
  })

  it('入力欄を空にしたら追跡をやめる（書き始め直し＝その下書きは使っていない）', () => {
    expect(trackUsedDraft('draft-1', '')).toBeNull()
    expect(trackUsedDraft('draft-1', '   \n ')).toBeNull()
  })

  it('もともと下書きから書き始めていなければ何も追跡しない', () => {
    expect(trackUsedDraft(null, '手で書いた文面')).toBeNull()
  })
})

describe('draftPreview', () => {
  it('改行を畳んで 1 行にする', () => {
    expect(draftPreview('お世話になります。\n\n本日ですが、')).toBe('お世話になります。 本日ですが、')
  })

  it('長い本文は省略する', () => {
    expect(draftPreview('あ'.repeat(80), 10)).toBe(`${'あ'.repeat(10)}…`)
    expect(draftPreview('あ'.repeat(10), 10)).toBe('あ'.repeat(10))
  })
})

describe('draftAuthorLabel', () => {
  it('機械経由（Claude の MCP / API キー）と人を見分ける', () => {
    expect(draftAuthorLabel({ createdVia: 'api', createdByName: null })).toBe('MCP / API')
    expect(draftAuthorLabel({ createdVia: 'admin', createdByName: '山田' })).toBe('山田')
    expect(draftAuthorLabel({ createdVia: 'admin', createdByName: null })).toBe('オペレーター')
  })
})
