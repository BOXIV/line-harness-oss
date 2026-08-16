'use client'

// BOXIV: オペレーターチャットの「Notion連携」。
// 出品者リスト / 購入者リストの候補を **常に両方併記** して出し、どの行と連携するかを選ばせる。
// どちらのDBも 1人が複数行を持ち得る（出品者: プレミアム出品 → アプリ出品へ変更 /
// 購入者: 取引管理DBなので 1人が複数の商談行）。選択した行のステータスだけが LINE Connect に
// 反映される（旧行を取引停止にしても影響しない）。出品者と購入者は独立に連携でき、
// 片方を選んでももう片方の連携は消えない。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type NotionCandidateGroup,
  type NotionLinkSource,
  type NotionSellerCandidate,
} from '@/lib/api'

interface Props {
  friendId: string
  /** 連携完了・失敗をチャット画面のメッセージ欄に出すためのコールバック */
  onLinked?: (message: string, linked: boolean) => void
  className?: string
}

/** DB 名。worker 側 LINK_SOURCE_LABELS と合わせる。 */
const SOURCE_LABELS: Record<NotionLinkSource, string> = {
  seller: '出品者リスト',
  buyer: '購入者リスト',
}

/** 行の識別子の呼び名（出品者=掲載ID / 購入者=商談ID）。 */
const ID_LABELS: Record<NotionLinkSource, string> = {
  seller: '掲載ID',
  buyer: '商談ID',
}

/** 行の補足情報の呼び名（出品者=出品タイプ / 購入者=車両）。 */
const DETAIL_LABELS: Record<NotionLinkSource, string> = {
  seller: '出品タイプ',
  buyer: '車両',
}

/** Notion の page id はハイフン有無が混在し得るので正規化して比較する */
function sameId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase()
}

function candidateSource(c: NotionSellerCandidate): NotionLinkSource {
  // 旧 worker（source を返さない）と繋がったときは出品者として扱う
  return c.source === 'buyer' ? 'buyer' : 'seller'
}

function candidateDetail(c: NotionSellerCandidate): string | null {
  return candidateSource(c) === 'buyer' ? c.vehicle ?? null : c.listingType ?? null
}

function candidateLabel(c: NotionSellerCandidate): string {
  const source = candidateSource(c)
  const parts: string[] = [c.label ? `${ID_LABELS[source]} ${c.label}` : `${ID_LABELS[source]} 未設定`]
  const detail = candidateDetail(c)
  if (detail) parts.push(detail)
  if (c.status) parts.push(c.status)
  if (c.matchedBy === 'name') parts.push('名前一致')
  return parts.join(' ・ ')
}

/** 旧 worker が groups を返さないときは、出品者だけの 1 グループへ畳む。 */
function toGroups(data: {
  groups?: NotionCandidateGroup[]
  candidates: NotionSellerCandidate[]
  linkedPageId: string | null
  pinned: boolean
}): NotionCandidateGroup[] {
  if (data.groups?.length) return data.groups
  return [
    {
      source: 'seller',
      candidates: data.candidates ?? [],
      error: null,
      linkedPageId: data.linkedPageId ?? null,
      pinned: Boolean(data.pinned),
    },
  ]
}

export default function NotionLinkPicker({ friendId, onLinked, className }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<NotionCandidateGroup[]>([])
  const [selectedPageId, setSelectedPageId] = useState<string>('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.chats.notionCandidates(friendId)
      if (res.success) {
        const next = toGroups(res.data)
        setGroups(next)
        // 連携中の行を初期選択。未連携なら先頭（＝自動判定と同じ優先順）。
        const all = next.flatMap((g) => g.candidates)
        const linked = next.flatMap((g) => g.candidates.filter((c) => sameId(c.pageId, g.linkedPageId)))
        setSelectedPageId(linked[0]?.pageId ?? all[0]?.pageId ?? '')
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

  const allCandidates = groups.flatMap((g) => g.candidates)
  const selected = allCandidates.find((c) => c.pageId === selectedPageId) ?? null
  const selectedSource = selected ? candidateSource(selected) : null
  const selectedGroup = selectedSource ? groups.find((g) => g.source === selectedSource) ?? null : null

  const handleApply = async () => {
    if (!selectedPageId || !selectedSource || saving) return
    setSaving(true)
    setError('')
    try {
      const res = await api.chats.notionLink(friendId, selectedPageId, selectedSource)
      if (res.success) {
        if (res.data.linked) {
          const link = res.data.link
          const source = link?.source ?? selectedSource
          const idText = link?.label ? `${ID_LABELS[source]} ${link.label}` : `${ID_LABELS[source]} 未設定の行`
          setOpen(false)
          onLinked?.(
            `✓ ${SOURCE_LABELS[source]}の ${idText} と連携しました${link?.realName ? `: ${link.realName}` : ''}`,
            true,
          )
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
        title="Notion 出品者リスト / 購入者リスト と連携する行を選択"
        aria-expanded={open}
      >
        🔗 Notion連携 {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[26rem] max-w-[calc(100vw-2rem)] rounded-md border border-gray-200 bg-white p-3 shadow-lg">
          <p className="text-xs font-semibold text-gray-700">連携する行を選択（出品者 / 購入者）</p>

          {loading ? (
            <div className="mt-2 h-8 animate-pulse rounded bg-gray-100" />
          ) : (
            <>
              {/* 現在の連携状況。連携済み / 未連携が両DBとも一目で分かるようにする。 */}
              <dl className="mt-2 space-y-0.5 rounded bg-slate-50 px-2 py-1.5 text-[11px]">
                {groups.map((g) => {
                  const linkedCandidate = g.candidates.find((c) => sameId(c.pageId, g.linkedPageId))
                  return (
                    <div key={g.source} className="flex gap-1">
                      <dt className="w-20 shrink-0 text-gray-400">{SOURCE_LABELS[g.source]}:</dt>
                      <dd className="truncate text-gray-700">
                        {g.linkedPageId ? (
                          <>
                            <span className="text-emerald-700">
                              ✓ {ID_LABELS[g.source]} {linkedCandidate?.label ?? '（候補外の行）'}
                            </span>
                            {g.pinned && <span className="ml-1" title="オペレーターが選択して固定済み">📌</span>}
                          </>
                        ) : (
                          <span className="text-gray-400">未連携</span>
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>

              {allCandidates.length === 0 ? (
                <p className="mt-2 text-[11px] text-gray-500">
                  出品者リスト・購入者リストのいずれにも該当する行が見つかりませんでした（LINE User ID / 名前とも一致なし）。
                </p>
              ) : (
                <select
                  value={selectedPageId}
                  onChange={(e) => setSelectedPageId(e.target.value)}
                  disabled={saving}
                  className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                >
                  {groups.map((g) => (
                    <optgroup key={g.source} label={SOURCE_LABELS[g.source]}>
                      {g.candidates.length === 0 ? (
                        <option value="" disabled>
                          {g.error ? '（取得に失敗）' : '（候補なし）'}
                        </option>
                      ) : (
                        g.candidates.map((c) => (
                          <option key={c.pageId} value={c.pageId}>
                            {sameId(c.pageId, g.linkedPageId) ? '✓ ' : ''}
                            {candidateLabel(c)}
                          </option>
                        ))
                      )}
                    </optgroup>
                  ))}
                </select>
              )}

              {selected && selectedSource && (
                <dl className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                  <div className="flex gap-1">
                    <dt className="w-20 shrink-0 text-gray-400">名前:</dt>
                    <dd className="truncate">{selected.realName ?? '—'}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="w-20 shrink-0 text-gray-400">{DETAIL_LABELS[selectedSource]}:</dt>
                    <dd className="truncate">{candidateDetail(selected) ?? '—'}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="w-20 shrink-0 text-gray-400">ステータス:</dt>
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

              {selectedGroup && selectedGroup.candidates.length > 1 && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  {SOURCE_LABELS[selectedGroup.source]}の候補が {selectedGroup.candidates.length} 件あります。選択した行のステータスのみ LINE Connect に反映され、他の行（旧プレミアム出品・終了した商談など）の取引停止は影響しません。
                </p>
              )}

              {groups.map((g) =>
                g.error ? (
                  <p key={g.source} className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                    ⚠ {SOURCE_LABELS[g.source]}の候補取得に失敗しました: {g.error}
                  </p>
                ) : g.linkedPageId && !g.candidates.some((c) => sameId(c.pageId, g.linkedPageId)) ? (
                  <p key={g.source} className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                    ⚠ {SOURCE_LABELS[g.source]}で連携中の行が候補に見つかりません（Notion 側で削除・アーカイブされた可能性）。ステータスが反映されなくなるため連携先を選び直してください。
                  </p>
                ) : null,
              )}

              {selectedGroup && selectedGroup.linkedPageId && !selectedGroup.pinned && (
                <p className="mt-1 text-[11px] text-gray-500">
                  {SOURCE_LABELS[selectedGroup.source]}は現在自動判定で連携中です。選択して確定するとこの行に固定されます。
                </p>
              )}

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={handleApply}
                  disabled={saving || !selectedPageId}
                  className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {saving
                    ? '連携中...'
                    : selectedSource
                      ? `この${ID_LABELS[selectedSource]}と連携する`
                      : '連携する'}
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
