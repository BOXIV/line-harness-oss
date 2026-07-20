'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import AreaTabs from '@/components/staff-availability/area-tabs'
import ShiftLogicModal from '@/components/staff-availability/shift-logic-modal'
import { AREA_LABELS, type AreaId } from '@/lib/area-meta'

const SLOT_OPTIONS = [
  { startTime: '10:00', endTime: '12:00' },
  { startTime: '12:00', endTime: '14:00' },
  { startTime: '14:00', endTime: '16:00' },
  { startTime: '16:00', endTime: '18:00' },
]

interface StaffMember {
  id: string
  name: string
  email: string | null
  role: string
  workArea?: string | null
}

interface AvailabilityRow {
  id: string
  staffId: string
  staffName: string | null
  date: string
  startTime: string
  endTime: string
  area: string
  isBooked: boolean
}

interface BookingRow {
  id: string
  customerName: string | null
  friendName: string | null
  prefecture: string
  area: string
  staffName: string | null
  plateNumber: string | null
  status: string
  slot: { id: string; date: string; startTime: string; endTime: string; area: string } | null
}

// JST 基準で YYYY-MM-DD を返す
function jstToday(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}
// YYYY-MM-DD に daysDelta 日加算（JST 基準、DST非考慮）
function addDays(dateStr: string, daysDelta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + daysDelta)
  return dt.toISOString().slice(0, 10)
}
// 日付ラベル (M/D 曜)
function formatDayShort(dateStr: string): { label: string; dayOfWeek: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12))
  const dow = dt.getUTCDay()
  const dowJa = ['日', '月', '火', '水', '木', '金', '土'][dow]
  return { label: `${m}/${d}(${dowJa})`, dayOfWeek: dow }
}

type ViewMode = 'list' | 'gantt'

export default function StaffAvailabilityPage() {
  const [items, setItems] = useState<AvailabilityRow[]>([])
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedStaffId, setSelectedStaffId] = useState<string>('all')
  const [listAreaFilter, setListAreaFilter] = useState<string>('all')
  const [listStatusFilter, setListStatusFilter] = useState<'free' | 'booked' | 'all'>('free')
  const [showCreate, setShowCreate] = useState(false)
  const [currentRole, setCurrentRole] = useState<string>('')
  const [currentStaffId, setCurrentStaffId] = useState<string>('')
  const [currentWorkArea, setCurrentWorkArea] = useState<string>('')
  const [createForm, setCreateForm] = useState({
    staffId: '',
    area: 'shutoken',
    dates: '',
    selectedSlots: [] as number[],
  })
  const [saving, setSaving] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('gantt')
  const [showLogic, setShowLogic] = useState(false)
  const [ganttStartDate, setGanttStartDate] = useState<string>(() => jstToday())
  const [ganttArea, setGanttArea] = useState<string>('shutoken')
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [bookingDetail, setBookingDetail] = useState<BookingRow | null>(null)

  useEffect(() => {
    api.staff.me().then((res) => {
      if (res.success) {
        setCurrentRole(res.data.role)
        setCurrentStaffId(res.data.id)
        if (res.data.role === 'staff') {
          // 撮影スタッフはエリアを選べない。自分の稼働エリア(work_area)を全面適用する。
          const wa = res.data.workArea || ''
          setCurrentWorkArea(wa)
          setCreateForm((prev) => ({ ...prev, staffId: res.data.id, area: wa || prev.area }))
          if (wa) setGanttArea(wa)
        }
      }
    }).catch(() => {})
  }, [])

  const isStaffRole = currentRole === 'staff'

  // シフト登録者として並ぶのは撮影スタッフ(role='staff')のみ。
  // オーナー/マネージャーは閲覧者として全撮影スタッフのシフトを見られるが、
  // 自身は撮影に入らないため、シフト行・登録ドロップダウンの対象には含めない。
  const shiftStaff = staff.filter((s) => s.role === 'staff')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: { staffId?: string; includeBooked: boolean } = { includeBooked: true }
      if (selectedStaffId !== 'all') params.staffId = selectedStaffId
      const [availRes, staffRes, bookingsRes] = await Promise.all([
        api.staffAvailability.list(params),
        api.staff.list(),
        api.bookingRequests.list({}),
      ])
      if (availRes.success) setItems(availRes.data || [])
      else setError(availRes.error || '読み込みに失敗しました')
      if (staffRes.success) setStaff(staffRes.data || [])
      if (bookingsRes.success) setBookings(bookingsRes.data || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedStaffId])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!createForm.staffId) {
      alert('スタッフを選択してください')
      return
    }
    if (createForm.selectedSlots.length === 0) {
      alert('時間枠を1つ以上選択してください')
      return
    }
    const dates = createForm.dates.split(/[\s,、]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.trim()))
    if (dates.length === 0) {
      alert('日付を YYYY-MM-DD 形式で1つ以上入力してください')
      return
    }

    setSaving(true)
    try {
      await api.staffAvailability.bulkCreate({
        staffId: createForm.staffId,
        area: createForm.area,
        dates,
        slots: createForm.selectedSlots.map((i) => SLOT_OPTIONS[i]),
      })
      setShowCreate(false)
      setCreateForm({ staffId: '', area: 'shutoken', dates: '', selectedSlots: [] })
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '登録に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('このスロットを削除しますか？')) return
    try {
      await api.staffAvailability.delete(id)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました')
    }
  }

  // Gantt: セルクリックで追加
  async function handleGanttAdd(staffId: string, date: string, area: string, startTime: string, endTime: string) {
    if (!confirm(`${date} ${startTime}〜${endTime} にシフトを追加しますか？`)) return
    try {
      await api.staffAvailability.create({ staffId, date, startTime, endTime, area })
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'シフト追加に失敗しました')
    }
  }

  // Gantt: セルクリックで削除
  async function handleGanttDelete(id: string, date: string, startTime: string, endTime: string) {
    if (!confirm(`${date} ${startTime}〜${endTime} のシフトを削除しますか？`)) return
    try {
      await api.staffAvailability.delete(id)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました')
    }
  }

  // Gantt ビューのレンダリング関数
  function renderGanttView() {
    // 14日間の日付配列
    const dates: string[] = []
    for (let i = 0; i < 14; i++) dates.push(addDays(ganttStartDate, i))

    // 表示対象スタッフ: staff ロールは自分のみ、adminはエリア該当するスタッフ（シフトを持つ人 + 全員から選択）
    // まずこのエリアでシフトを持つスタッフIDを集める
    const staffInArea = new Set<string>()
    for (const it of items) {
      if (it.area === ganttArea) staffInArea.add(it.staffId)
    }
    // 表示は全スタッフ（シフトがなくてもクリックで追加できるように）
    const displayStaff = isStaffRole
      ? staff.filter((s) => s.id === currentStaffId)
      : shiftStaff

    // スロット定義（表示は4枠）
    const slots = SLOT_OPTIONS

    // (staffId|date|startTime) → row lookup
    const slotMap = new Map<string, AvailabilityRow>()
    for (const it of items) {
      if (it.area !== ganttArea) continue
      slotMap.set(`${it.staffId}|${it.date}|${it.startTime}`, it)
    }

    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3 flex-wrap">
          {!isStaffRole ? (
            <div className="flex items-start gap-2 w-full">
              <label className="text-xs text-gray-500 mt-2 shrink-0">エリア</label>
              <AreaTabs value={ganttArea} onChange={(v) => setGanttArea(v as AreaId)} />
            </div>
          ) : (
            <div className="flex items-center gap-2 w-full">
              <label className="text-xs text-gray-500 shrink-0">稼働エリア</label>
              <span className="text-sm font-medium text-gray-800">
                {currentWorkArea ? (AREA_LABELS[currentWorkArea] || currentWorkArea) : '未設定'}
              </span>
              <span className="text-[11px] text-gray-400">（マネージャーが設定）</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGanttStartDate(addDays(ganttStartDate, -14))}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              ← 前2週
            </button>
            <span className="text-sm font-medium text-gray-700">
              {ganttStartDate} 〜 {addDays(ganttStartDate, 13)}
            </span>
            <button
              onClick={() => setGanttStartDate(addDays(ganttStartDate, 14))}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              次2週 →
            </button>
            <button
              onClick={() => setGanttStartDate(jstToday())}
              className="px-3 py-1.5 text-sm bg-white border border-gray-300 hover:bg-gray-50 rounded-lg"
            >
              今日
            </button>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="ml-auto text-sm px-4 py-2 text-white font-medium rounded-lg"
            style={{ background: '#0f172a' }}
          >
            + 一括登録
          </button>
        </div>

        {loading ? (
          <div className="py-12 text-center text-gray-500">読み込み中...</div>
        ) : isStaffRole && !currentWorkArea ? (
          <div className="py-12 text-center text-gray-500 text-sm">
            稼働エリアが未設定です。マネージャーに稼働エリアの設定を依頼してください。
          </div>
        ) : displayStaff.length === 0 ? (
          <div className="py-12 text-center text-gray-500">スタッフが登録されていません</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="sticky left-0 bg-gray-50 border-b border-r border-gray-200 px-3 py-2 text-left font-medium text-gray-600 min-w-[120px]">
                    スタッフ / 時間
                  </th>
                  {dates.map((d) => {
                    const { label, dayOfWeek } = formatDayShort(d)
                    const bg = dayOfWeek === 0 ? 'text-red-500' : dayOfWeek === 6 ? 'text-blue-500' : 'text-gray-700'
                    return (
                      <th key={d} className={`border-b border-gray-200 px-2 py-2 text-center font-medium ${bg} min-w-[60px]`}>
                        {label}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {displayStaff.map((s, si) => (
                  <>
                    {slots.map((slot, sloti) => (
                      <tr key={`${s.id}-${slot.startTime}`} className={sloti === 0 ? 'border-t-2 border-gray-300' : ''}>
                        <td className={`sticky left-0 bg-white border-r border-b border-gray-200 px-3 py-2 ${sloti === 0 ? 'font-bold text-gray-900' : 'text-gray-500 text-[11px]'}`}>
                          {sloti === 0 ? (
                            <div>
                              <div>{s.name}</div>
                              <div className="text-[10px] text-gray-400 font-normal mt-0.5">{slot.startTime}〜{slot.endTime}</div>
                            </div>
                          ) : (
                            <div className="pl-0">{slot.startTime}〜{slot.endTime}</div>
                          )}
                        </td>
                        {dates.map((d) => {
                          const key = `${s.id}|${d}|${slot.startTime}`
                          const row = slotMap.get(key)
                          if (!row) {
                            return (
                              <td key={d} className="border-b border-gray-100 p-0">
                                <button
                                  onClick={() => handleGanttAdd(s.id, d, ganttArea, slot.startTime, slot.endTime)}
                                  className="w-full h-full min-h-[36px] text-gray-300 hover:bg-sky-50 hover:text-sky-600 transition-colors"
                                  title="クリックでシフト追加"
                                >
                                  +
                                </button>
                              </td>
                            )
                          }
                          if (row.isBooked) {
                            // 紐づく予約を検索
                            const booking = bookings.find((b) => b.slot?.id === row.id)
                            return (
                              <td key={d} className="border-b border-gray-100 p-1 bg-yellow-50">
                                <button
                                  onClick={() => {
                                    if (booking) setBookingDetail(booking)
                                    else alert('紐づく予約情報が見つかりません')
                                  }}
                                  className="w-full h-8 bg-yellow-200 hover:bg-yellow-300 rounded text-yellow-900 flex items-center justify-center font-bold transition-colors"
                                  title="クリックで予約詳細を表示"
                                >
                                  ✕
                                </button>
                              </td>
                            )
                          }
                          return (
                            <td key={d} className="border-b border-gray-100 p-1">
                              <button
                                onClick={() => handleGanttDelete(row.id, d, slot.startTime, slot.endTime)}
                                className="w-full h-8 bg-sky-500 hover:bg-red-400 rounded text-white font-bold flex items-center justify-center transition-colors"
                                title="クリックでシフト削除"
                              >
                                ○
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-5 py-3 border-t border-gray-200 flex items-center gap-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 bg-sky-500 rounded"></div>
            <span>空き（クリックで削除）</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 bg-yellow-200 rounded"></div>
            <span>予約済み</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 border border-gray-300 rounded text-gray-400 flex items-center justify-center text-[10px]">+</div>
            <span>未登録（クリックで追加）</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <Header
        title="スタッフシフト管理"
        action={
          <button
            onClick={() => setShowLogic(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-3.5 py-2 text-xs font-medium text-slate-700 shadow-sm backdrop-blur transition hover:bg-white hover:shadow"
            title="撮影予約・シフトロジックの解説を表示"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 7.1v3.5M8 5.1h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            シフトロジック
          </button>
        }
      />
      <main className="px-6 py-6">
        {showLogic && <ShiftLogicModal onClose={() => setShowLogic(false)} />}

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* View モード切替タブ */}
        <div className="mb-4 flex items-center gap-2">
          <button
            onClick={() => setViewMode('gantt')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              viewMode === 'gantt' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-300'
            }`}
          >
            📅 ガント表示
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              viewMode === 'list' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-300'
            }`}
          >
            📋 リスト表示
          </button>
        </div>

        {viewMode === 'gantt' && renderGanttView()}

        {viewMode === 'list' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3 flex-wrap">
            {!isStaffRole && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">スタッフ</label>
                <select
                  value={selectedStaffId}
                  onChange={(e) => setSelectedStaffId(e.target.value)}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-1.5"
                >
                  <option value="all">すべてのスタッフ</option>
                  {shiftStaff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            {isStaffRole && (
              <div className="text-xs text-gray-500">自分のシフトのみ表示中</div>
            )}
            <div className="flex items-start gap-2 w-full">
              <label className="text-xs text-gray-500 mt-2 shrink-0">エリア</label>
              <AreaTabs value={listAreaFilter} onChange={(v) => setListAreaFilter(v)} includeAll />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">状態</label>
              <select
                value={listStatusFilter}
                onChange={(e) => setListStatusFilter(e.target.value as 'free' | 'booked' | 'all')}
                className="text-sm border border-gray-300 rounded-lg px-3 py-1.5"
              >
                <option value="free">空きのみ</option>
                <option value="booked">予約済みのみ</option>
                <option value="all">すべて</option>
              </select>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="ml-auto text-sm px-4 py-2 text-white font-medium rounded-lg"
              style={{ background: '#0f172a' }}
            >
              + シフト一括登録
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">日付</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">時間</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">エリア</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">スタッフ</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">状態</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600"></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  if (loading) return <tr><td colSpan={6} className="text-center text-gray-500 py-8">読み込み中...</td></tr>
                  const filtered = items.filter((row) => {
                    if (listAreaFilter !== 'all' && row.area !== listAreaFilter) return false
                    if (listStatusFilter === 'free' && row.isBooked) return false
                    if (listStatusFilter === 'booked' && !row.isBooked) return false
                    return true
                  })
                  if (filtered.length === 0) return <tr><td colSpan={6} className="text-center text-gray-500 py-8">該当するシフトはありません</td></tr>
                  return filtered.map((row) => (
                    <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{row.date}</td>
                      <td className="px-4 py-3 text-gray-700">{row.startTime}〜{row.endTime}</td>
                      <td className="px-4 py-3 text-gray-700">{AREA_LABELS[row.area] || row.area}</td>
                      <td className="px-4 py-3 text-gray-700">{row.staffName || row.staffId}</td>
                      <td className="px-4 py-3">
                        {row.isBooked ? (
                          <span className="inline-block px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">予約あり</span>
                        ) : (
                          <span className="inline-block px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">空き</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!row.isBooked && (
                          <button
                            onClick={() => handleDelete(row.id)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            削除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {/* 予約詳細モーダル（ガント予約済みセル用） */}
        {bookingDetail && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
            onClick={() => setBookingDetail(null)}
          >
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">予約詳細</h2>
                <button onClick={() => setBookingDetail(null)} className="text-gray-400 hover:text-gray-600">✕</button>
              </div>
              <div className="px-6 py-5 space-y-3 text-sm">
                <div>
                  <div className="text-xs text-gray-500">お客様</div>
                  <div className="font-bold text-gray-900">{bookingDetail.customerName || bookingDetail.friendName || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">都道府県 / エリア</div>
                  <div className="font-medium text-gray-900">
                    {bookingDetail.prefecture} / {AREA_LABELS[bookingDetail.area] || bookingDetail.area}
                  </div>
                </div>
                {bookingDetail.slot && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-1">撮影日時</div>
                    <div className="font-bold text-gray-900">
                      {bookingDetail.slot.date} {bookingDetail.slot.startTime}〜{bookingDetail.slot.endTime}
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-gray-500">担当スタッフ</div>
                  <div className="font-medium text-gray-900">{bookingDetail.staffName || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">ナンバー下4桁</div>
                  <div className="font-bold font-mono text-gray-900">{bookingDetail.plateNumber || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">ステータス</div>
                  <div>
                    <span className={`inline-block px-2 py-1 rounded-full text-xs font-bold ${
                      bookingDetail.status === 'approved' ? 'bg-sky-100 text-sky-800' :
                      bookingDetail.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      bookingDetail.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {bookingDetail.status === 'approved' ? '承認済み' :
                       bookingDetail.status === 'pending' ? '承認待ち' :
                       bookingDetail.status === 'rejected' ? '却下' : bookingDetail.status}
                    </span>
                  </div>
                </div>
                <div className="pt-3 border-t border-gray-100">
                  <a
                    href={`/bookings`}
                    className="block w-full text-center px-4 py-2 text-white text-sm font-medium rounded-lg hover:opacity-90"
                    style={{ backgroundColor: '#0f172a' }}
                  >
                    予約管理ページで詳細を開く
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* シフト一括登録モーダル */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowCreate(false)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">シフト一括登録</h2>
                <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600">
                  ✕
                </button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">スタッフ</label>
                  {isStaffRole ? (
                    <div className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-700">
                      自分（{staff.find((s) => s.id === currentStaffId)?.name || ''}）
                    </div>
                  ) : (
                    <select
                      value={createForm.staffId}
                      onChange={(e) => setCreateForm({ ...createForm, staffId: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    >
                      <option value="">選択してください</option>
                      {shiftStaff.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">エリア</label>
                  {isStaffRole ? (
                    <div className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-700">
                      {currentWorkArea ? (AREA_LABELS[currentWorkArea] || currentWorkArea) : '未設定（マネージャーに設定を依頼してください）'}
                    </div>
                  ) : (
                    <select
                      value={createForm.area}
                      onChange={(e) => setCreateForm({ ...createForm, area: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    >
                      {Object.entries(AREA_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    {isStaffRole ? '稼働エリアはマネージャーが「スタッフ管理」で設定します。' : 'この日はこのエリアでのみ予約を受けます（1日1エリア）'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">日付（YYYY-MM-DD、複数可）</label>
                  <textarea
                    value={createForm.dates}
                    onChange={(e) => setCreateForm({ ...createForm, dates: e.target.value })}
                    rows={3}
                    placeholder="2026-04-10&#10;2026-04-11&#10;2026-04-12"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                  <p className="text-xs text-gray-500 mt-1">改行・カンマ・スペース区切り</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">時間枠</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {SLOT_OPTIONS.map((slot, i) => {
                      const selected = createForm.selectedSlots.includes(i)
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            const next = selected
                              ? createForm.selectedSlots.filter((x) => x !== i)
                              : [...createForm.selectedSlots, i]
                            setCreateForm({ ...createForm, selectedSlots: next })
                          }}
                          className={`px-3 py-2 text-sm rounded-lg border-2 ${
                            selected
                              ? 'border-green-500 bg-green-50 text-green-800 font-medium'
                              : 'border-gray-200 text-gray-600'
                          }`}
                        >
                          {slot.startTime}〜{slot.endTime}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">夏期 (5-8月) は16:00以降も選択可</p>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setShowCreate(false)}
                    className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={saving}
                    className="flex-1 px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                    style={{ background: '#0f172a' }}
                  >
                    {saving ? '登録中...' : '登録'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
