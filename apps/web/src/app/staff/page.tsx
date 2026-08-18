'use client'
import { useState, useEffect } from 'react'
import Header from '@/components/layout/header'
import { api, fetchApi } from '@/lib/api'
import { useDisplayRole } from '@/contexts/current-staff-context'
import { AREA_LABELS } from '@/lib/area-meta'
import type { ApiResponse } from '@line-crm/shared'
import type { StaffMember } from '@line-crm/shared'

// shared の StaffMember はまだ workArea を持たないためローカルで拡張（撮影スタッフの稼働エリア）。
type StaffRow = StaffMember & { workArea?: string | null }

type NewApiKey = { apiKey: string; staffId: string }

function RoleBadge({ role }: { role: string }) {
  const styles =
    role === 'owner'
      ? 'bg-yellow-100 text-yellow-800'
      : role === 'manager'
        ? 'bg-purple-100 text-purple-800'
        : role === 'admin'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-gray-100 text-gray-600'
  const label =
    role === 'owner'
      ? 'オーナー'
      : role === 'manager'
        ? 'マネージャー'
        : role === 'admin'
          ? '管理者'
          : '撮影スタッフ'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••'
  return key.slice(0, 4) + '••••••••' + key.slice(-4)
}

export default function StaffPage() {
  const [members, setMembers] = useState<StaffRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // New API key banner
  const [newKey, setNewKey] = useState<NewApiKey | null>(null)
  /** 管理者が発行した救済用ログインコード（メールが届かない人に口頭 / LINE で伝える） */
  const [issuedCode, setIssuedCode] = useState<{
    code: string
    expiresAt: string
    name: string
    email: string | null
  } | null>(null)
  /** メールアドレスのインライン編集（オーナーのみ）。id → 入力中の値 */
  const [editingEmail, setEditingEmail] = useState<{ id: string; value: string } | null>(null)
  const [emailSaving, setEmailSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  // Create form
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formRole, setFormRole] = useState<'owner' | 'admin' | 'manager' | 'staff'>('staff')
  const [formWorkArea, setFormWorkArea] = useState<string>('shutoken')
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState('')

  // ログイン中ユーザーのロール（manager は撮影スタッフのみ追加可）
  // ロールの正は GET /api/staff/me（CurrentStaffProvider 経由）。
  // localStorage を直接読むと、権限を変えた直後の人が古い画面のままになる。
  const myRole = useDisplayRole()
  const isManager = myRole === 'manager'
  // メール変更は Worker 側で owner のみ。ボタンを出すかどうかもそれに合わせる
  // （出しても 403 になるだけだが、押せるのに必ず失敗するボタンは出さない）。
  const isOwner = myRole === 'owner'

  const loadMembers = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchApi<ApiResponse<StaffRow[]>>('/api/staff')
      if (res.success) {
        setMembers(res.data)
      } else {
        setError(res.error ?? 'スタッフの読み込みに失敗しました')
      }
    } catch {
      setError('スタッフの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMembers()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormLoading(true)
    setFormError('')
    try {
      // メールアドレスはログイン（6桁コードの宛先）そのものなので必須。
      // 空で作るとその人は永久にログインできず、救済コードの宛先も無い。
      const body: { name: string; role: 'owner' | 'admin' | 'manager' | 'staff'; email: string; workArea?: string } = {
        name: formName,
        role: formRole,
        email: formEmail.trim(),
      }
      // 稼働エリアは撮影スタッフのみ設定
      if (formRole === 'staff') body.workArea = formWorkArea

      const res = await fetchApi<ApiResponse<StaffRow & { apiKey?: string }>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (res.success) {
        if (res.data.apiKey) {
          setNewKey({ apiKey: res.data.apiKey, staffId: res.data.id })
        }
        setFormName('')
        setFormEmail('')
        setFormRole('staff')
        setFormWorkArea('shutoken')
        setShowForm(false)
        await loadMembers()
      } else {
        setFormError(res.error ?? '作成に失敗しました')
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setFormLoading(false)
    }
  }

  const handleToggleActive = async (member: StaffMember) => {
    try {
      await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      await loadMembers()
    } catch {
      setError('更新に失敗しました')
    }
  }

  const handleUpdateWorkArea = async (member: StaffRow, workArea: string) => {
    // 楽観更新（即時反映）。失敗したら再読込で戻す。
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, workArea } : m)))
    try {
      await fetchApi<ApiResponse<StaffRow>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ workArea }),
      })
    } catch {
      setError('稼働エリアの更新に失敗しました')
      await loadMembers()
    }
  }

  const handleRegenerateKey = async (member: StaffMember) => {
    if (!confirm(`${member.name} のAPIキーを再生成しますか？\n現在のキーは無効になります。`)) return
    try {
      const res = await fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${member.id}/regenerate-key`, {
        method: 'POST',
      })
      if (res.success) {
        setNewKey({ apiKey: res.data.apiKey, staffId: member.id })
      } else {
        setError(res.error ?? 'キー再生成に失敗しました')
      }
    } catch {
      setError('キー再生成に失敗しました')
    }
  }

  /**
   * 救済用ログインコードの発行。
   *
   * メールが届かない人を入れるための経路だが、**構造上その人になりすませる**機能でもある。
   * しかも旧方式のキー再生成と違って本人のログインを壊さないので、本人は気づかない。
   * 発行者名は変更ログと Slack に必ず残る（それが唯一の抑止力）。
   */
  const handleIssueLoginCode = async (member: StaffRow) => {
    if (
      !confirm(
        `${member.name} のログインコードを発行しますか？\n\n` +
          'このコードを使うと、その人として管理画面に入れます。\n' +
          '本人以外には絶対に渡さないでください。\n' +
          '発行した事実とあなたの名前は変更ログと Slack に残ります。',
      )
    )
      return
    try {
      const res = await api.staff.issueLoginCode(member.id)
      if (res.success) {
        setIssuedCode({
          code: res.data.code,
          expiresAt: res.data.expiresAt,
          name: member.name,
          email: res.data.staff.email,
        })
      } else {
        setError(res.error ?? 'ログインコードの発行に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインコードの発行に失敗しました')
    }
  }

  /**
   * メールアドレスの変更（オーナーのみ）。
   *
   * メールはログインの本人確認そのものなので、Worker 側は owner にしか許可していない
   * （マネージャーに開けると、撮影スタッフのアドレスを自分のものへ書き換えて成り代われる）。
   * 一方で「メール未設定・重複のスタッフはログインも救済コードも成立しない」ため、
   * 画面から直せる口が無いと詰む。ここがその唯一の口。
   */
  const handleSaveEmail = async () => {
    if (!editingEmail) return
    setEmailSaving(true)
    setError('')
    try {
      const res = await api.staff.update(editingEmail.id, { email: editingEmail.value.trim() })
      if (res.success) {
        setEditingEmail(null)
        await loadMembers()
      } else {
        setError(res.error ?? 'メールアドレスの更新に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'メールアドレスの更新に失敗しました')
    } finally {
      setEmailSaving(false)
    }
  }

  const handleDelete = async (member: StaffMember) => {
    if (!confirm(`${member.name} を削除しますか？\nこの操作は元に戻せません。`)) return
    try {
      await fetchApi<ApiResponse<null>>(`/api/staff/${member.id}`, { method: 'DELETE' })
      await loadMembers()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    await navigator.clipboard.writeText(newKey.apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <Header
        title="スタッフ管理"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#0f172a' }}
          >
            + スタッフを追加
          </button>
        }
      />

      {/* New API key banner */}
      {newKey && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800 mb-2">
            APIキーが発行されました。このキーは一度しか表示されません。
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-green-200 rounded px-3 py-2 font-mono break-all">
              {newKey.apiKey}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-2 text-xs font-medium text-green-700 bg-white border border-green-300 rounded-lg hover:bg-green-50 transition-colors"
            >
              {copied ? 'コピー済み' : 'コピー'}
            </button>
            <button
              onClick={() => setNewKey(null)}
              className="shrink-0 px-3 py-2 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 救済用ログインコード */}
      {issuedCode && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-300 rounded-lg">
          <p className="text-sm font-medium text-amber-900 mb-1">
            {issuedCode.name} さんのログインコードを発行しました
          </p>
          <p className="text-xs text-amber-800 mb-3">
            本人だけに伝えてください。このコードで、その人として管理画面に入れます。
            発行した事実とあなたの名前は変更ログに残ります。
          </p>
          <p className="text-xs text-amber-800 mb-3">
            このコードでログインするときに入力するメールアドレス:{' '}
            <span className="font-mono">{issuedCode.email ?? '（未登録）'}</span>
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-lg bg-white border border-amber-300 rounded px-3 py-2 font-mono tracking-[0.3em] text-center">
              {issuedCode.code}
            </code>
            <button
              onClick={() => setIssuedCode(null)}
              className="shrink-0 px-3 py-2 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              閉じる
            </button>
          </div>
          <p className="text-xs text-amber-700 mt-2">
            有効期限: {new Date(issuedCode.expiresAt).toLocaleString('ja-JP')} / 1 回だけ使えます
          </p>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">新しいスタッフを追加</h2>

          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-900">
            <p className="font-bold mb-2">ロール別権限</p>
            <ul className="space-y-1 leading-relaxed">
              <li><span className="inline-block px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 font-bold mr-2">オーナー</span>全機能（スタッフ管理 + システム設定）</li>
              <li><span className="inline-block px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold mr-2">マネージャー</span>スタッフ管理可、システム設定（LINE Channel 等）は不可。オーナーの作成・編集・削除は不可</li>
              <li><span className="inline-block px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold mr-2">管理者</span>スタッフ管理以外の全機能（予約承認、配信、友だち管理など）</li>
              <li><span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-bold mr-2">撮影スタッフ</span>シフト登録と自分の担当予約確認のみ</li>
            </ul>
            <p className="mt-2 text-[11px] text-blue-700">※ 撮影スタッフ用アカウントは「撮影スタッフ」を選択してください</p>
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">名前 *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                  placeholder="田中 太郎"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">メールアドレス *</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  required
                  placeholder="taro@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  ログイン用の認証コードはここへ届きます。本人が受信できるアドレスを入れてください。
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ロール *</label>
                {isManager ? (
                  <>
                    <select
                      value="staff"
                      disabled
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-gray-100 text-gray-500 cursor-not-allowed focus:outline-none"
                    >
                      <option value="staff">撮影スタッフ（シフト登録専用）</option>
                    </select>
                    <p className="mt-1 text-[11px] text-gray-500">マネージャーは撮影スタッフのみ追加できます</p>
                  </>
                ) : (
                  <select
                    value={formRole}
                    onChange={(e) => setFormRole(e.target.value as 'owner' | 'admin' | 'manager' | 'staff')}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="staff">撮影スタッフ（シフト登録専用）</option>
                    <option value="admin">管理者</option>
                    <option value="manager">マネージャー</option>
                    <option value="owner">オーナー</option>
                  </select>
                )}
              </div>
            </div>
            {formRole === 'staff' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">稼働エリア＊（撮影スタッフ）</label>
                <select
                  value={formWorkArea}
                  onChange={(e) => setFormWorkArea(e.target.value)}
                  className="w-full sm:max-w-xs px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {Object.entries(AREA_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-gray-500">この撮影スタッフが稼働するエリア。シフトはこのエリアで登録されます（後から変更可）。</p>
              </div>
            )}
            {formError && (
              <p className="text-sm text-red-600">{formError}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={formLoading || !formName || !formEmail}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#0f172a' }}
              >
                {formLoading ? '作成中...' : '作成'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError('') }}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Staff list */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-48" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-5 bg-gray-100 rounded w-24" />
              <div className="h-8 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">スタッフがいません。「+ スタッフを追加」から追加してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">名前</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">メール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ロール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">稼働エリア</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">APIキー</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">状態</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{member.name}</td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                    {editingEmail?.id === member.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="email"
                          value={editingEmail.value}
                          onChange={(e) => setEditingEmail({ id: member.id, value: e.target.value })}
                          className="w-48 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-green-500"
                          autoFocus
                        />
                        <button
                          onClick={handleSaveEmail}
                          disabled={emailSaving || !editingEmail.value.trim()}
                          className="px-2 py-1 text-xs text-green-700 border border-green-300 rounded hover:bg-green-50 disabled:opacity-50"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => setEditingEmail(null)}
                          className="px-2 py-1 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className={member.email ? '' : 'text-red-600'}>
                          {member.email ?? '未登録（ログインできません）'}
                        </span>
                        {isOwner && (
                          <button
                            onClick={() => setEditingEmail({ id: member.id, value: member.email ?? '' })}
                            className="text-[11px] text-blue-600 hover:underline"
                            title="ログイン用メールアドレスを変更します。旧アドレスへ通知が飛び、全セッションが失効します"
                          >
                            変更
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={member.role} />
                  </td>
                  <td className="px-4 py-3">
                    {member.role === 'staff' ? (
                      <select
                        value={member.workArea ?? ''}
                        onChange={(e) => handleUpdateWorkArea(member, e.target.value)}
                        className="text-xs border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                      >
                        <option value="">未設定</option>
                        {Object.entries(AREA_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden md:table-cell">
                    {maskKey(member.apiKey ?? '')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${member.isActive ? 'text-green-700' : 'text-gray-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${member.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {member.isActive ? '有効' : '無効'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {member.role !== 'owner' && (
                        <>
                          <button
                            onClick={() => handleToggleActive(member)}
                            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                          >
                            {member.isActive ? '無効化' : '有効化'}
                          </button>
                          {member.isActive && (
                            <button
                              onClick={() => handleIssueLoginCode(member)}
                              className="px-2.5 py-1 text-xs font-medium text-amber-700 bg-white border border-amber-300 rounded hover:bg-amber-50 transition-colors"
                              title="メールが届かないときに、この人として入れるコードを発行します"
                            >
                              ログインコード発行
                            </button>
                          )}
                          <button
                            onClick={() => handleRegenerateKey(member)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-600 bg-white border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                          >
                            キー再生成
                          </button>
                          <button
                            onClick={() => handleDelete(member)}
                            className="px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 transition-colors"
                          >
                            削除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
