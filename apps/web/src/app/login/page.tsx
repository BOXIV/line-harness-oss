'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { setLegacyApiKey, setSession, setStaffProfile } from '@/lib/auth'

/**
 * 管理画面ログイン（BOXIV）
 *
 * 主導線は「メールアドレス → 届いた6桁コード」の2段。
 * メール内のリンクを開いてもコードは消費されない（消費は必ずこの画面からの POST）。
 * Microsoft SafeLinks 等のメールスキャナが URL を先読みして単回リンクを潰す事故を避けるため、
 * リンクは入力欄を埋めるだけで、送信は人が押したときだけ行う。
 *
 * APIキー入力は「管理者用」として畳んで残してある。理由:
 *   env API_KEY の保持者にはメールアドレスが無く（合成の env-owner）、メール配信が
 *   止まったときの最後の入口がこれになる。ここを消すと復旧経路ごと消える。
 *   旧方式の遮断フェーズでこの欄ごと外す。
 */
function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()

  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKey, setApiKey] = useState('')

  // メールのリンクから来た場合は入力欄を埋めるだけ。自動送信はしない
  // （自動送信にすると、リンクを先読みするスキャナがそのままコードを消費し得る）。
  useEffect(() => {
    const qsEmail = params.get('email')
    const qsCode = params.get('code')
    if (qsEmail) setEmail(qsEmail)
    if (qsCode) {
      setCode(qsCode)
      setStep('code')
      setNotice('メールのコードを読み込みました。「ログイン」を押してください。')
    }
  }, [params])

  /**
   * fetchApi は `API error: <status>: <サーバのメッセージ>` を throw する。
   * 400（入力の形が違う）はサーバの文言をそのまま出す — ここを握り潰して
   * 「送信に失敗しました」等の汎用文言に丸めると、入力の誤りを直しようがなくなる。
   * 401（資格情報が合わない）は理由を明かさない汎用文言に倒す。
   */
  function messageFor(err: unknown, fallback: string): string {
    const text = err instanceof Error ? err.message : ''
    const m = /^API error: (\d{3})(?:: (.*))?$/s.exec(text)
    if (m && m[1] === '400' && m[2]) return m[2]
    return fallback
  }

  /** ログイン後の着地先。撮影スタッフはシフト画面、それ以外はダッシュボード。 */
  function landingFor(role: string): string {
    const next = params.get('next')
    if (next && next.startsWith('/') && !next.startsWith('//')) return next
    return role === 'staff' ? '/staff-availability' : '/'
  }

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setNotice('')
    try {
      await api.auth.start(email.trim())
      setStep('code')
      // Worker は宛先の存在を明かさないので、画面もそれに合わせた文言にする。
      setNotice('登録されているメールアドレスであれば、認証コードを送信しました。')
    } catch (err) {
      setError(messageFor(err, '送信に失敗しました。時間をおいて再度お試しください。'))
    } finally {
      setLoading(false)
    }
  }

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.auth.verify(email.trim(), code.trim())
      if (!res.success || !res.data) {
        setError('メールアドレスまたは認証コードが正しくありません')
        return
      }
      setSession(res.data.token)
      setStaffProfile(res.data.staff.name, res.data.staff.role)
      router.push(landingFor(res.data.staff.role))
    } catch (err) {
      // 401（コード不一致 / 期限切れ / 未登録）は理由を区別しない＝総当たりの手がかりを与えない。
      // 400（入力の形が違う）だけはサーバの文言を出す。
      setError(messageFor(err, 'メールアドレスまたは認証コードが正しくありません'))
    } finally {
      setLoading(false)
    }
  }

  const submitApiKey = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      // 検証は /api/staff/me で行う。認証済みなら全ロールが 200 を返す唯一の口で、
      // ロール制限のあるルートを使うと弱いロールが「キーが不正」に見えて締め出される
      // （2026-08-15 に /api/friends/count へ認可を足して実際に起きた）。
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'
      const res = await fetch(`${apiUrl}/api/staff/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        setError('APIキーが正しくありません')
        return
      }
      const profile = await res.json()
      if (!profile?.success || !profile?.data) {
        setError('APIキーが正しくありません')
        return
      }
      setLegacyApiKey(apiKey)
      setStaffProfile(profile.data.name, profile.data.role)
      router.push(landingFor(profile.data.role))
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent'

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0f172a' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <img src="/logo.png" alt="BOXIV" className="w-12 h-12 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900">BOXIV LINE Connect</h1>
          <p className="text-sm text-gray-500 mt-1">管理画面にログイン</p>
        </div>

        {step === 'email' ? (
          <form onSubmit={sendCode}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
                autoComplete="email"
                autoFocus
              />
            </div>
            <p className="text-xs text-gray-500 mb-4">
              登録済みのメールアドレスに6桁の認証コードを送ります。
            </p>
            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
            <button
              type="submit"
              disabled={loading || !email}
              className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#0f172a' }}
            >
              {loading ? '送信中...' : '認証コードを送る'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('code'); setNotice('') }}
              className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-700"
            >
              コードを受け取っている場合はこちら
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                autoComplete="email"
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">認証コード（6桁）</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                maxLength={7}
                className={`${inputClass} tracking-[0.4em] text-center text-lg`}
                autoFocus
              />
            </div>

            {notice && <p className="text-xs text-gray-600 mb-3">{notice}</p>}
            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

            <button
              type="submit"
              disabled={loading || !email || !code}
              className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#0f172a' }}
            >
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setError(''); setNotice('') }}
              className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-700"
            >
              メールアドレスを入力し直す / コードを再送する
            </button>
          </form>
        )}

        <div className="mt-6 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setShowApiKey((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            {showApiKey ? '閉じる' : 'APIキーでログイン（管理者用）'}
          </button>
          {showApiKey && (
            <form onSubmit={submitApiKey} className="mt-3">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="APIキーを入力"
                className={inputClass}
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={loading || !apiKey}
                className="w-full mt-2 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                APIキーでログイン
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  // useSearchParams は Suspense 境界の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ backgroundColor: '#0f172a' }} />}>
      <LoginForm />
    </Suspense>
  )
}
