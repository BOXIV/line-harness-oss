'use client'
/**
 * ログイン中のスタッフ（BOXIV）。
 *
 * ロールの出所を **GET /api/staff/me だけ** にするための入れ物。
 * 以前は localStorage の 'lh_staff_role' を各画面が直接読んでいたが、
 *   - 利用者が devtools で書き換えられる（表示だけとはいえ、実態と食い違う）
 *   - 権限を変えても本人が再ログインするまで画面が古いロールのまま
 * という問題があった。localStorage は「最初の描画をちらつかせない」ためのキャッシュに降格し、
 * 正はサーバの応答とする。
 *
 * 認可そのものは毎リクエスト Worker 側が staff_members を引き直して決めるので、
 * ここが古くても権限は取れない。ここが決めるのは表示とナビゲーションだけ。
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { getCachedName, getCachedRole, isAuthenticated, setStaffProfile } from '@/lib/auth'

export interface CurrentStaff {
  id: string
  name: string
  role: string
  email: string | null
  workArea: string | null
}

interface CurrentStaffValue {
  staff: CurrentStaff | null
  /** サーバから引き直すまでは true。ロールで分岐する処理はこれが false になるまで待つ。 */
  loading: boolean
  /** サーバ確定前の暫定ロール（localStorage キャッシュ）。初回描画のちらつき防止用。 */
  cachedRole: string | null
  cachedName: string | null
}

const Ctx = createContext<CurrentStaffValue>({
  staff: null,
  loading: true,
  cachedRole: null,
  cachedName: null,
})

export function CurrentStaffProvider({ children }: { children: React.ReactNode }) {
  const [staff, setStaff] = useState<CurrentStaff | null>(null)
  const [loading, setLoading] = useState(true)
  const [cachedRole, setCachedRole] = useState<string | null>(null)
  const [cachedName, setCachedName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCachedRole(getCachedRole())
    setCachedName(getCachedName())

    if (!isAuthenticated()) {
      setLoading(false)
      return
    }

    api.staff
      .me()
      .then((res) => {
        if (cancelled || !res.success || !res.data) return
        const next: CurrentStaff = {
          id: res.data.id,
          name: res.data.name,
          role: res.data.role,
          email: res.data.email,
          workArea: res.data.workArea,
        }
        setStaff(next)
        // 次回の初回描画用にキャッシュを更新する（正はあくまでサーバ）。
        setStaffProfile(next.name, next.role)
        setCachedRole(next.role)
        setCachedName(next.name)
      })
      .catch(() => {
        // 401 は fetchApi 側でセッション破棄 → /login へ遷移する。
        // それ以外（ネットワーク断など）はキャッシュのまま画面を出す。
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return <Ctx.Provider value={{ staff, loading, cachedRole, cachedName }}>{children}</Ctx.Provider>
}

export function useCurrentStaff(): CurrentStaffValue {
  return useContext(Ctx)
}

/** 表示・ナビゲーション用のロール。サーバ確定値 → 無ければキャッシュ。 */
export function useDisplayRole(): string | null {
  const { staff, cachedRole } = useCurrentStaff()
  return staff?.role ?? cachedRole
}
