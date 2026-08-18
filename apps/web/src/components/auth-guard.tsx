'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { isAuthenticated } from '@/lib/auth'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    // ⚠️ 完全一致ではなく前方一致で判定する。メールのリンクは
    //    /login?email=…&code=… で着地するし、将来 /login/… を足すこともある。
    //    完全一致のままだと着地ページが未ログイン扱いでリダイレクトされ、
    //    せっかく開いたコード入力画面が消える。
    if (pathname.startsWith('/login')) {
      setChecked(true)
      return
    }

    if (!isAuthenticated()) {
      const next = encodeURIComponent(pathname)
      router.replace(`/login?next=${next}`)
    } else {
      setChecked(true)
    }
  }, [pathname, router])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}
