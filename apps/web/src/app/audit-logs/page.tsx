'use client'

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'

interface AuditLog {
  id: string
  lineAccountId: string | null
  actorId: string | null
  actorName: string | null
  actorRole: string | null
  action: string
  summary: string
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  method: string
  path: string
  status: number | null
  detail: unknown
  createdAt: string
}

interface FilterOptions {
  actions: Array<{ action: string; summary: string; count: number }>
  actors: Array<{ actorId: string | null; actorName: string | null; count: number }>
}

interface ListResponse {
  success: boolean
  data?: { items: AuditLog[]; total: number; page: number; limit: number; hasNextPage: boolean }
  error?: string
}

const PAGE_SIZE = 30

const ROLE_LABEL: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  manager: 'マネージャー',
  staff: '撮影スタッフ',
}
const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-yellow-100 text-yellow-800',
  admin: 'bg-blue-100 text-blue-800',
  manager: 'bg-green-100 text-green-800',
  staff: 'bg-gray-100 text-gray-600',
}
const METHOD_BADGE: Record<string, string> = {
  POST: 'bg-emerald-100 text-emerald-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-red-100 text-red-700',
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function AuditLogsPage() {
  const { selectedAccountId } = useAccount()
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [page, setPage] = useState(1)

  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ actions: [], actors: [] })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // フィルタ/アカウント連打時の応答レース対策（古い応答で上書きしない）
  const loadSeq = useRef(0)

  // フィルタ候補（操作者 / アクション種別）
  useEffect(() => {
    const q = selectedAccountId ? '?lineAccountId=' + selectedAccountId : ''
    fetchApi<{ success: boolean; data?: FilterOptions }>('/api/audit-logs/filters' + q)
      .then((res) => {
        if (res.success && res.data) setFilterOptions(res.data)
      })
      .catch(() => {
        /* フィルタ候補は失敗しても本体には影響させない */
      })
  }, [selectedAccountId])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const q: Record<string, string> = {
        offset: String((page - 1) * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      }
      if (selectedAccountId) q.lineAccountId = selectedAccountId
      if (actor) q.actor = actor
      if (action) q.action = action
      if (from) q.from = from
      if (to) q.to = to
      const res = await fetchApi<ListResponse>('/api/audit-logs?' + new URLSearchParams(q))
      if (seq !== loadSeq.current) return // 古い応答は破棄
      if (res.success && res.data) {
        setLogs(res.data.items)
        setTotal(res.data.total)
        setHasNextPage(res.data.hasNextPage)
      } else {
        setError(res.error || '変更ログの読み込みに失敗しました。')
      }
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? e.message : '変更ログの読み込みに失敗しました。')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [page, selectedAccountId, actor, action, from, to])

  // フィルタ / アカウント変更で 1 ページ目に戻す
  useEffect(() => {
    setPage(1)
  }, [selectedAccountId, actor, action, from, to])
  useEffect(() => {
    load()
  }, [load])

  const clearFilters = () => {
    setActor('')
    setAction('')
    setFrom('')
    setTo('')
  }
  const hasFilter = Boolean(actor || action || from || to)

  return (
    <div>
      <Header title="変更ログ" description="管理画面で「いつ・だれが・何を変更したか」の履歴" />

      {/* フィルタ */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center mb-4">
        <select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
        >
          <option value="">すべての操作者</option>
          {filterOptions.actors.map((a) => (
            <option key={a.actorId ?? 'system'} value={a.actorId ?? ''}>
              {(a.actorName || a.actorId || 'システム') + `（${a.count}）`}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
        >
          <option value="">すべてのアクション</option>
          {filterOptions.actions.map((a) => (
            <option key={a.action} value={a.action}>
              {a.summary + `（${a.count}）`}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="開始日"
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
        />
        <span className="text-gray-400 text-sm hidden sm:inline">〜</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="終了日"
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
        />
        {hasFilter && (
          <button
            onClick={clearFilters}
            className="text-sm text-gray-500 hover:text-gray-900 px-3 py-2 min-h-[44px]"
          >
            クリア
          </button>
        )}
      </div>

      {error && <div className="mb-4 text-sm text-red-500">{error}</div>}

      {/* テーブル */}
      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : logs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          変更ログがありません
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">日時</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作者</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作内容</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">対象</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((l) => {
                const role = l.actorRole || ''
                const isOpen = expanded === l.id
                return (
                  <Fragment key={l.id}>
                    <tr className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {formatDateTime(l.createdAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {l.actorName || l.actorId || 'システム'}
                        </div>
                        {role && (
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mt-0.5 ${ROLE_BADGE[role] || 'bg-gray-100 text-gray-600'}`}
                          >
                            {ROLE_LABEL[role] || role}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900">{l.summary}</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">{l.action}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 max-w-[220px]">
                        {l.targetLabel ? (
                          <span className="truncate block" title={l.targetLabel}>
                            {l.targetLabel}
                          </span>
                        ) : l.targetType ? (
                          <span className="text-gray-400">
                            {l.targetType}
                            {l.targetId ? ` #${l.targetId.slice(0, 8)}` : ''}
                          </span>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => setExpanded(isOpen ? null : l.id)}
                          className="text-xs text-slate-600 hover:text-slate-900"
                        >
                          {isOpen ? '閉じる' : '表示'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <span
                              className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${METHOD_BADGE[l.method] || 'bg-gray-100 text-gray-600'}`}
                            >
                              {l.method}
                            </span>
                            <code className="text-xs text-gray-600">{l.path}</code>
                            {l.status != null && (
                              <span className="text-[11px] text-gray-400">HTTP {l.status}</span>
                            )}
                          </div>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-3 overflow-x-auto text-gray-700">
                            {JSON.stringify(l.detail, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ページネーション */}
      {!loading && logs.length > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-gray-400">
            {(page - 1) * PAGE_SIZE + 1}〜{(page - 1) * PAGE_SIZE + logs.length} 件 / 全 {total} 件
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
            >
              前へ
            </button>
            <span className="px-3 py-1.5 text-sm text-gray-500">{page}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
            >
              次へ
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
