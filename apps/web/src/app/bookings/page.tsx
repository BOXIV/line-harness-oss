'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

const AREA_LABELS: Record<string, string> = {
  shutoken: '首都圏',
  chubu: '中部',
  kinki: '近畿',
  kanto_suburban: '関東郊外',
  kyushu: '九州',
  other: 'その他',
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending_invite: { label: '招待中', color: 'bg-blue-100 text-blue-800' },
  pending: { label: '承認待ち', color: 'bg-yellow-100 text-yellow-800' },
  approved: { label: '承認済み', color: 'bg-green-100 text-green-800' },
  rejected: { label: '却下', color: 'bg-red-100 text-red-800' },
  cancelled: { label: 'キャンセル', color: 'bg-gray-100 text-gray-800' },
}

interface BookingRow {
  id: string
  friendId: string | null
  friendName: string | null
  staffId: string | null
  staffName: string | null
  inviteToken: string
  customerName: string | null
  prefecture: string
  area: string
  slot: { id: string; date: string; startTime: string; endTime: string; area: string } | null
  plateNumber: string | null
  status: string
  notes: string | null
  createdAt: string
}

export default function BookingsPage() {
  const [items, setItems] = useState<BookingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('pending')
  const [areaFilter, setAreaFilter] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string>('')

  useEffect(() => {
    api.staff.me().then((res) => {
      if (res.success) setCurrentRole(res.data.role)
    }).catch(() => {})
  }, [])

  // 承認/否認は manager も可。削除は owner/admin のみ。
  const canApproveReject =
    currentRole === 'admin' || currentRole === 'owner' || currentRole === 'manager'
  const canDelete = currentRole === 'admin' || currentRole === 'owner'
  const [detail, setDetail] = useState<{
    id: string
    status: string
    plate_number: string | null
    customer_name: string | null
    prefecture: string
    area: string
    notes: string | null
    friend_name: string | null
    candidate_1_date: string | null; candidate_1_start: string | null; candidate_1_end: string | null
    candidate_2_date: string | null; candidate_2_start: string | null; candidate_2_end: string | null
    candidate_3_date: string | null; candidate_3_start: string | null; candidate_3_end: string | null
    selected_candidate: number | null
    slot: { id: string; date: string; start_time: string; end_time: string; area: string } | null
    alternativeStaff: Array<{ availabilityId: string; staffId: string; staffName: string | null }>
  } | null>(null)
  const [otherCandidate, setOtherCandidate] = useState<1 | 2 | 3>(1)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 全件取得してクライアント側でタブフィルタ + カウント表示
      const params: { area?: string } = {}
      if (areaFilter !== 'all') params.area = areaFilter
      const res = await api.bookingRequests.list(params)
      if (res.success) {
        setItems(res.data || [])
      } else {
        setError(res.error || '読み込みに失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [areaFilter])

  useEffect(() => { load() }, [load])

  async function openDetail(id: string) {
    setSelectedId(id)
    setOtherCandidate(1)
    try {
      const res = await api.bookingRequests.get(id)
      if (res.success) {
        setDetail(res.data)
      } else {
        setError(res.error || '詳細の取得に失敗しました')
      }
    } catch {
      setError('詳細の取得に失敗しました')
    }
  }

  async function changeStaff(slotId: string) {
    if (!detail) return
    try {
      await api.bookingRequests.update(detail.id, { slotId })
      await openDetail(detail.id)
      await load()
    } catch {
      setError('スタッフ変更に失敗しました')
    }
  }

  async function approve(id: string) {
    if (!confirm('この予約を承認しますか？出品者にLINE通知が送信されます。')) return
    try {
      const selected = detail?.area === 'other' ? otherCandidate : undefined
      await api.bookingRequests.approve(id, selected)
      setSelectedId(null)
      setDetail(null)
      await load()
    } catch {
      setError('承認に失敗しました')
    }
  }

  async function reject(id: string) {
    const notes = prompt('却下理由（任意）')
    if (notes === null) return
    try {
      await api.bookingRequests.reject(id, notes || undefined)
      setSelectedId(null)
      setDetail(null)
      await load()
    } catch {
      setError('却下に失敗しました')
    }
  }

  async function deleteBooking(id: string) {
    if (!confirm('この予約を削除しますか？取り消せません。')) return
    try {
      await api.bookingRequests.delete(id)
      setSelectedId(null)
      setDetail(null)
      await load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <>
      <Header title="撮影予約一覧" />
      <main className="px-6 py-6">
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* ステータスタブ（件数バッジ付き） */}
        {(() => {
          const counts: Record<string, number> = { all: items.length }
          for (const s of ['pending_invite', 'pending', 'approved', 'rejected', 'cancelled']) {
            counts[s] = items.filter((i) => i.status === s).length
          }
          const tabs: Array<{ key: string; label: string; color: string }> = [
            { key: 'pending', label: '承認待ち', color: 'yellow' },
            { key: 'pending_invite', label: '招待中', color: 'blue' },
            { key: 'approved', label: '承認済み', color: 'green' },
            { key: 'rejected', label: '却下', color: 'red' },
            { key: 'all', label: 'すべて', color: 'gray' },
          ]
          return (
            <div className="mb-4 flex items-center gap-2 overflow-x-auto">
              {tabs.map((t) => {
                const active = statusFilter === t.key
                const count = counts[t.key] || 0
                return (
                  <button
                    key={t.key}
                    onClick={() => setStatusFilter(t.key)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap border ${
                      active
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {t.label}
                    <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs rounded-full ${
                      active ? 'bg-white text-gray-900' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })()}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">エリア</label>
              <select
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-1.5"
              >
                <option value="all">すべて</option>
                {Object.entries(AREA_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <button
              onClick={load}
              className="ml-auto text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              更新
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">日時</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">お客様</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">エリア</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">担当スタッフ</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">ナンバー</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">ステータス</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600"></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  if (loading) return <tr><td colSpan={7} className="text-center text-gray-500 py-8">読み込み中...</td></tr>
                  const filtered = statusFilter === 'all' ? items : items.filter((i) => i.status === statusFilter)
                  // pending を最優先で表示、他は作成日時順（DBが既に降順）
                  const statusOrder: Record<string, number> = { pending: 0, pending_invite: 1, approved: 2, rejected: 3, cancelled: 4 }
                  const sorted = [...filtered].sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99))
                  if (sorted.length === 0) return <tr><td colSpan={7} className="text-center text-gray-500 py-8">該当する予約はありません</td></tr>
                  return sorted.map((row) => {
                    const status = STATUS_LABELS[row.status] || { label: row.status, color: 'bg-gray-100' }
                    const isPending = row.status === 'pending'
                    return (
                      <tr
                        key={row.id}
                        className={`border-t border-gray-100 ${isPending ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-4 py-3">
                          {row.slot ? (
                            <div>
                              <div className="font-medium text-gray-900">{row.slot.date}</div>
                              <div className="text-xs text-gray-500">{row.slot.startTime}-{row.slot.endTime}</div>
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs">未選択</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{row.customerName || row.friendName || '-'}</div>
                          <div className="text-xs text-gray-500">{row.prefecture}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{AREA_LABELS[row.area] || row.area}</td>
                        <td className="px-4 py-3 text-gray-700">{row.staffName || '-'}</td>
                        <td className="px-4 py-3 font-mono text-gray-900">{row.plateNumber || '-'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${status.color}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => openDetail(row.id)}
                            className="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg text-white transition-opacity hover:opacity-90 whitespace-nowrap"
                            style={{ backgroundColor: '#0f172a' }}
                          >
                            確認
                          </button>
                        </td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        </div>

        {/* 詳細モーダル */}
        {detail && (
          <div className="fixed inset-0 bg-black/40 flex items-end md:items-center justify-center z-50 p-4" onClick={() => { setDetail(null); setSelectedId(null) }}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">予約詳細</h2>
                <button onClick={() => { setDetail(null); setSelectedId(null) }} className="text-gray-400 hover:text-gray-600">
                  ✕
                </button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-xs text-gray-500">お客様名</div>
                    <div className="font-medium text-gray-900">{detail.customer_name || detail.friend_name || '-'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">都道府県</div>
                    <div className="font-medium text-gray-900">{detail.prefecture}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">エリア</div>
                    <div className="font-medium text-gray-900">{AREA_LABELS[detail.area] || detail.area}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">ナンバー</div>
                    <div className="font-medium text-gray-900 font-mono">{detail.plate_number || '-'}</div>
                  </div>
                </div>

                {detail.slot && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-1">予約日時</div>
                    <div className="font-bold text-gray-900">{detail.slot.date} {detail.slot.start_time}〜{detail.slot.end_time}</div>
                  </div>
                )}

                {detail.area === 'other' && detail.candidate_1_date && (
                  <div>
                    <div className="text-xs text-gray-500 mb-2">出品者の希望日程（1つ選んで承認）</div>
                    <div className="space-y-2">
                      {[1, 2, 3].map((n) => {
                        const d = detail[`candidate_${n}_date` as 'candidate_1_date']
                        const s = detail[`candidate_${n}_start` as 'candidate_1_start']
                        const e = detail[`candidate_${n}_end` as 'candidate_1_end']
                        if (!d) return null
                        return (
                          <label
                            key={n}
                            className={`flex items-center gap-3 px-4 py-3 border-2 rounded-lg cursor-pointer ${
                              otherCandidate === n ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                            }`}
                          >
                            <input
                              type="radio"
                              name="candidate"
                              checked={otherCandidate === n}
                              onChange={() => setOtherCandidate(n as 1 | 2 | 3)}
                            />
                            <div className="text-sm">
                              <div className="font-bold text-gray-900">第{n}候補</div>
                              <div className="text-gray-600">{d} {s}〜{e}</div>
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}

                {detail.alternativeStaff.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-500 mb-2">担当スタッフを変更</div>
                    <div className="space-y-1">
                      {detail.alternativeStaff.map((alt) => (
                        <button
                          key={alt.availabilityId}
                          onClick={() => changeStaff(alt.availabilityId)}
                          className="block w-full text-left px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
                        >
                          {alt.staffName || alt.staffId}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {detail.notes && (
                  <div>
                    <div className="text-xs text-gray-500">メモ</div>
                    <div className="text-sm text-gray-700">{detail.notes}</div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  {detail.status === 'pending' && canApproveReject && (
                    <>
                      <button
                        onClick={() => approve(detail.id)}
                        className="flex-1 px-4 py-2 text-white text-sm font-medium rounded-lg hover:opacity-90"
                        style={{ backgroundColor: '#0f172a' }}
                      >
                        承認
                      </button>
                      <button
                        onClick={() => reject(detail.id)}
                        className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg"
                      >
                        却下
                      </button>
                    </>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => deleteBooking(detail.id)}
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg"
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
