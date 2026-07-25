'use client'

// BOXIV: オペレーターチャットの「Notion連携」。
// 1人の出品者が複数の掲載ID行を持つ場合（プレミアム出品 → アプリ出品へ変更、何度も変更する人）
// があるため、押すと候補をドロップダウンで出し、どの掲載IDと連携するかを選ばせる。
// 選択した掲載ID行のステータスだけが LINE Connect に反映される（旧行を取引停止にしても影響しない）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type NotionSellerCandidate } from '@/lib/api'

interface Props {
  friendId: string
  /** 連携完了・失敗をチャット画面のメッセージ欄に出すためのコールバック */
  onLinked?: (message: string, linked: boolean) => void
  className?: string
}

/** Notion の page id はハイフン有無が混在し得るので正規化して比較する */
function sameId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase()
}

function candidateLabel(c: NotionSellerCandidate): string {
  const parts: string[] = [c.label ? `掲載ID ${c.label}` : '掲載ID 未設定']
  if (c.listingType) parts.push(c.listingType)
  if (c.status) parts.push(c.status)
  if (c.matchedBy === 'name') parts.push('名前一致')
  return parts.join(' ・ ')
}

export default function NotionLinkPicker({ friendId, onLinked, className }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<NotionSellerCandidate[]>([])
  const [linkedPageId, setLinkedPageId] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [selectedPageId, setSelectedPageId] = useState<string>('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.chats.notionCandidates(friendId)
      if (res.success) {
        setCandidates(res.data.candidates)
        setLinkedPageId(res.data.linkedPageId)
        setPinned(res.data.pinned)
        // 連携中の行を初期選択。未連携なら先頭（＝自動判定と同じ優先順）。
        const initial = res.data.candidates.find((c) => sameId(c.pageId, res.data.linkedPageId))
        setSelectedPageId(initial?.pageId ?? res.data.candidates[0]?.pageId ?? '')
      } else {
        setError(res.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '候補の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  // パネルを開いたときに候補を取得（友だちを切り替えたら閉じる）
  useEffect(() => {
    if (open) load()
  }, [open, load])

  useEffect(() => {
    setOpen(false)
  }, [friendId])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = candidates.find((c) => c.pageId === selectedPageId) ?? null

  const handleApply = async () => {
    if (!selectedPageId || saving) return
    setSaving(true)
    setError('')
    try {
      const res = await api.chats.notionLink(friendId, selectedPageId)
      if (res.success) {
        if (res.data.linked) {
          const link = res.data.link
          const idText = link?.label ? `掲載ID ${link.label}` : '掲載ID 未設定の行'
          setLinkedPageId(link?.pageId ?? selectedPageId)
          setPinned(true)
          setOpen(false)
          onLinked?.(`✓ ${idText} と連携しました${link?.realName ? `: ${link.realName}` : ''}`, true)
        } else {
          setError(res.data.message ?? '該当レコードが見つかりませんでした')
        }
      } else {
        setError(res.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '連携に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ''}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors"
        title="Notion 出品者DB と連携する掲載IDを選択"
        aria-expanded={open}
      >
        🔗 Notion連携 {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[22rem] max-w-[calc(100vw-2rem)] rounded-md border border-gray-200 bg-white p-3 shadow-lg">
          <p className="text-xs font-semibold text-gray-700">連携する掲載IDを選択</p>

          {loading ? (
            <div className="mt-2 h-8 animate-pulse rounded bg-gray-100" />
          ) : candidates.length === 0 ? (
            <p className="mt-2 text-[11px] text-gray-500">
              Notion 出品者DB に該当する行が見つかりませんでした（LINE User ID / 名前のいずれも一致なし）。
            </p>
          ) : (
            <>
              <select
                value={selectedPageId}
                onChange={(e) => setSelectedPageId(e.target.value)}
                disabled={saving}
                className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
              >
                {candidates.map((c) => (
                  <option key={c.pageId} value={c.pageId}>
                    {sameId(c.pageId, linkedPageId) ? '✓ ' : ''}
                    {candidateLabel(c)}
                  </option>
                ))}
              </select>

              {selected && (
                <dl className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                  <div className="flex gap-1">
                    <dt className="shrink-0 text-gray-400">名前:</dt>
                    <dd className="truncate">{selected.realName ?? '—'}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="shrink-0 text-gray-400">出品タイプ:</dt>
                    <dd className="truncate">{selected.listingType ?? '—'}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="shrink-0 text-gray-400">ステータス:</dt>
                    <dd className="truncate">{selected.status ?? '未設定'}</dd>
                  </div>
                  {selected.matchedBy === 'name' && (
                    <p className="text-amber-700">
                      ⚠ この行は LINE User ID 未記入で、名前一致で拾った候補です。同姓同名の別人でないか確認してください。
                    </p>
                  )}
                  {selected.url && (
                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block text-blue-600 hover:underline"
                    >
                      Notion で開く ↗
                    </a>
                  )}
                </dl>
              )}

              {candidates.length > 1 && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  候補が {candidates.length} 件あります。選択した掲載ID行のステータスのみ LINE Connect に反映され、他の行（旧プレミアム出品など）の取引停止は影響しません。
                </p>
              )}

              {linkedPageId && !candidates.some((c) => sameId(c.pageId, linkedPageId)) && (
                <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                  ⚠ 現在連携中の行が候補に見つかりません（Notion 側で削除・アーカイブされた可能性）。ステータスが反映されなくなるため連携先を選び直してください。
                </p>
              )}

              {linkedPageId && !pinned && (
                <p className="mt-1 text-[11px] text-gray-500">
                  現在は自動判定で連携中です。選択して確定するとこの掲載IDに固定されます。
                </p>
              )}

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={handleApply}
                  disabled={saving || !selectedPageId}
                  className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {saving ? '連携中...' : 'この掲載IDと連携する'}
                </button>
                <button
                  onClick={() => load()}
                  disabled={loading || saving}
                  className="rounded px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                  再取得
                </button>
              </div>
            </>
          )}

          {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
