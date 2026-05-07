'use client'
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Sidebar from './layout/sidebar'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/contexts/account-context'

// staffロール（撮影スタッフ）がアクセス可能なパス
const STAFF_ALLOWED_PREFIXES = ['/bookings', '/staff-availability', '/login']

function StaffRoleGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const role = localStorage.getItem('lh_staff_role')
    if (role !== 'staff') return
    const allowed = STAFF_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
    if (!allowed) {
      router.replace('/staff-availability')
    }
  }, [pathname, router])

  return <>{children}</>
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/login') {
    return <>{children}</>
  }

  return (
    <AuthGuard>
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
    </AuthGuard>
  )
}
