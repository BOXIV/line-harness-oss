'use client'

import Link from 'next/link'
import Header from '@/components/layout/header'
import RichMenuStatusMappingTable from '@/components/rich-menus/rich-menu-status-mapping-table'

export default function RichMenuAutoSwitchPage() {
  return (
    <div>
      <Header
        title="リッチメニュー 自動切替"
        description="顧客ステータス（出品者 / 購入者）に応じて、リッチメニューを自動で切り替えます。/chats でステータスを変更したときに発火します。"
        action={
          <Link
            href="/rich-menus"
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            ← 一覧に戻る
          </Link>
        }
      />

      <RichMenuStatusMappingTable />
    </div>
  )
}
