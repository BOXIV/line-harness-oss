import type { Metadata, Viewport } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'

// ビルド環境判定（test / 本番）
const _API_URL = process.env.NEXT_PUBLIC_API_URL || ''
const IS_DEV = _API_URL.includes('line-connect-test')
const IS_PROD = _API_URL.includes('line-connect.boxiv.workers.dev')

export const metadata: Metadata = {
  title: IS_DEV ? 'BOXIV LINE Connect 管理画面（Dev）' : IS_PROD ? 'BOXIV LINE Connect 管理画面（本番）' : 'BOXIV LINE Connect 管理画面',
  description: 'BOXIV LINE Connect 管理画面',
  icons: {
    icon: { url: '/favicon.svg', type: 'image/svg+xml' },
  },
}

// モバイルで正しくスケールさせる（デスクトップ幅でのレンダリングを防ぐ）
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
