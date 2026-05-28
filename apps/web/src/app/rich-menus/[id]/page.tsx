'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { RichMenu } from '@/lib/rich-menu-types'
import Header from '@/components/layout/header'
import RichMenuPreview from '@/components/rich-menus/rich-menu-preview'

interface Props {
  params: Promise<{ id: string }>
}

function actionDisplay(action: RichMenu['areas'][number]['action']): string {
  switch (action.type) {
    case 'postback': return `postback: ${action.data}`
    case 'message': return `message: ${action.text}`
    case 'uri': return `uri: ${action.uri}`
    case 'datetimepicker': return `datetimepicker (${action.mode}): ${action.data}`
    case 'richmenuswitch': return `richmenuswitch → ${action.richMenuAliasId}`
  }
}

export default function RichMenuDetailPage({ params }: Props) {
  const { id } = use(params)
  const [menu, setMenu] = useState<RichMenu | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.richMenus.list()
        if (cancelled) return
        if (res.success) {
          const found = res.data.find((m) => m.richMenuId === id)
          if (!found) setError('リッチメニューが見つかりません')
          else setMenu(found)
        } else {
          setError(res.error)
        }
      } catch {
        setError('リッチメニューの読み込みに失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div>
        <Header title="リッチメニュー詳細" />
        <div className="text-sm text-gray-500">読み込み中...</div>
      </div>
    )
  }

  if (error || !menu) {
    return (
      <div>
        <Header
          title="リッチメニュー詳細"
          action={
            <Link
              href="/rich-menus"
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              ← 一覧
            </Link>
          }
        />
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      </div>
    )
  }

  return (
    <div>
      <Header
        title={menu.name}
        description="LINE 仕様上、エリアと画像は作成後の変更ができません。変更したい場合は『これを元に新規作成』を使ってください。"
        action={
          <div className="flex items-center gap-2">
            <Link
              href={`/rich-menus/new?from=${encodeURIComponent(menu.richMenuId)}`}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#0f172a' }}
            >
              これを元に新規作成
            </Link>
            <Link
              href="/rich-menus"
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              ← 一覧
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <RichMenuPreview menu={menu} maxWidth={800} />
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-gray-800">メタ情報</h2>
            <dl className="text-xs space-y-1.5">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">richMenuId</dt>
                <dd className="font-mono text-gray-700 truncate">{menu.richMenuId}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">チャットバー</dt>
                <dd className="text-gray-700">{menu.chatBarText}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">サイズ</dt>
                <dd className="text-gray-700">{menu.size.width} × {menu.size.height}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">selected</dt>
                <dd className="text-gray-700">{menu.selected ? 'true (デフォルト)' : 'false'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">エリア数</dt>
                <dd className="text-gray-700">{menu.areas.length}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-2">エリア一覧</h2>
            <ol className="text-xs space-y-2">
              {menu.areas.map((area, i) => (
                <li key={i} className="border-l-2 border-gray-200 pl-2 py-1">
                  <div className="text-gray-500">
                    #{i + 1} · {area.bounds.x},{area.bounds.y} {area.bounds.width}×{area.bounds.height}
                  </div>
                  <div className="text-gray-700 break-all">{actionDisplay(area.action)}</div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
