'use client'
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Sidebar from './layout/sidebar'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/contexts/account-context'
import { CurrentStaffProvider, useCurrentStaff } from '@/contexts/current-staff-context'

// staffロール（撮影スタッフ）がアクセス可能なパス
const STAFF_ALLOWED_PREFIXES = ['/bookings', '/staff-availability', '/login']

function StaffRoleGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { staff, loading, cachedRole } = useCurrentStaff()

  useEffect(() => {
    if (typeof window === 'undefined') return
    // ロールの正は GET /api/staff/me。確定するまでは追い出さない
    // （キャッシュだけで判断すると、権限が上がった直後の人を撮影スタッフ扱いで
    //   シフト画面へ蹴り続けることになる）。
    if (loading) return
    // 表示上の出し分けだけ。実際の認可は毎リクエスト Worker 側が staff_members を
    // 引き直して決めるので、ここを書き換えても権限は取れない。
    const role = staff?.role ?? cachedRole
    if (role !== 'staff') return
    const allowed = STAFF_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
    if (!allowed) {
      router.replace('/staff-availability')
    }
  }, [pathname, router, staff, loading, cachedRole])

  return <>{children}</>
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // AuthGuard 側と同じく前方一致。/login?email=…&code=… で着地するため。
  if (pathname.startsWith('/login')) {
    return <>{children}</>
  }

  return (
    <AuthGuard>
      <CurrentStaffProvider>
        <AccountProvider>
          <StaffRoleGuard>
            <div className="flex min-h-screen">
              <Sidebar />
              <main className="flex-1 pt-[72px] px-4 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8 overflow-auto">
                {children}
              </main>
            </div>
          </StaffRoleGuard>
        </AccountProvider>
      </CurrentStaffProvider>
    </AuthGuard>
  )
}
