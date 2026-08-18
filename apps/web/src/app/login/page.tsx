'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      // APIキーの検証は /api/staff/me で行う（認証済みなら全ロールが 200 を返す唯一の口）。
      //
      // ここでロール制限のあるルートを使うと、権限の弱いロールが「キーが不正」に
      // 見えてログイン自体できなくなる。実際に旧実装は /api/friends/count を叩いており、
      // 同ルートが requireRole('owner','admin','manager') で保護された時点（2026-08-15）から
      // 撮影スタッフ(role=staff)が 403 →「APIキーが正しくありません」で締め出された。
      // /api/staff/me は名前とロールも返すので、プロフィール取得も1往復で兼ねる。
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'
      const res = await fetch(`${apiUrl}/api/staff/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (res.ok) {
        const profile = await res.json()
        if (!profile?.success || !profile?.data) {
          setError('APIキーが正しくありません')
          return
        }
        localStorage.setItem('lh_api_key', apiKey)
        localStorage.setItem('lh_staff_name', profile.data.name)
        localStorage.setItem('lh_staff_role', profile.data.role)
        // 撮影スタッフは /staff-availability へ、それ以外はダッシュボードへ
        router.push(profile.data.role === 'staff' ? '/staff-availability' : '/')
      } else {
        setError('APIキーが正しくありません')
      }
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0f172a' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <img src="/logo.png" alt="BOXIV" className="w-12 h-12 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900">BOXIV LINE Connect</h1>
          <p className="text-sm text-gray-500 mt-1">管理画面にログイン</p>
        </div>

        <form onSubmit={handleLogin}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="APIキーを入力"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 mb-4">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !apiKey}
            className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#0f172a' }}
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
      </div>
    </div>
  )
}
