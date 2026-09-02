// 送信相手ごとの下書き（message_drafts）を入力欄で扱うときの純粋関数（BOXIV）。
//
// 下書きは「あらかじめ用意しておいた文面」なので、送ったあとも残っていると
// 「まだ送っていない下書き」と見分けが付かなくなる。そこで **送信に成功したら
// 挿入元の下書きを消す**。ただし消してよいのは「その下書きから書き始めた入力を
// そのまま送ったとき」だけなので、入力欄が空になった時点で追跡をやめる。

/**
 * 入力欄の内容が変わったあと、挿入元として覚えておく下書き ID。
 * 空（＝書き始め直し）になったら、その下書きは使わなかったことにする。
 */
export function trackUsedDraft(usedDraftId: string | null, inputValue: string): string | null {
  if (!inputValue.trim()) return null
  return usedDraftId
}

/** 一覧に出す 1 行プレビュー。改行は空白に畳み、長い本文は省略する。 */
export function draftPreview(content: string, maxLength = 60): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

/** 作成元の表示。人が置いたものは名前、機械経由（Claude の MCP / API キー）は出所を出す。 */
export function draftAuthorLabel(draft: {
  createdVia: 'admin' | 'api'
  createdByName: string | null
}): string {
  if (draft.createdVia === 'api') return 'MCP / API'
  return draft.createdByName?.trim() || 'オペレーター'
}
