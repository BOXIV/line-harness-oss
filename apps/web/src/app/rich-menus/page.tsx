'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { RichMenu } from '@line-crm/shared'
import Header from '@/components/layout/header'
import RichMenuPreview from '@/components/rich-menus/rich-menu-preview'

export default function RichMenusPage() {
  const [menus, setMenus] = useState<RichMenu[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.richMenus.list()
      if (res.success) {
        setMenus(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('リッチメニューの読み込みに失敗しました。LINE トークン未設定の可能性があります。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleSetDefault = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    try {
      const res = await api.richMenus.setDefault(id)
      if (res.success) {
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('デフォルト設定に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (menu: RichMenu) => {
    if (!confirm(`リッチメニュー「${menu.name}」を削除してもよいですか？\nLINE Platform からも完全に削除されます。`)) return
    if (busyId) return
    setBusyId(menu.richMenuId)
    try {
      const res = await api.richMenus.delete(menu.richMenuId)
      if (res.success) {
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('削除に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <Header
        title="リッチメニュー"
        description="LINE 公式アカウントのリッチメニューを管理します。デフォルト設定・編集・削除が可能です。"
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/rich-menus/auto-switch"
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              自動切替設定
            </Link>
            <Link
              href="/rich-menus/new"
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#0f172a' }}
            >
              + 新規作成
            </Link>
          </div>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-4 py-6 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="h-16 w-24 bg-gray-100 rounded" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-48" />
                <div className="h-2 bg-gray-100 rounded w-32" />
              </div>
              <div className="h-8 w-24 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      ) : menus.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 mb-3">リッチメニューが登録されていません。</p>
          <Link
            href="/rich-menus/new"
            className="inline-block px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#0f172a' }}
          >
            + 最初のリッチメニューを作成
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {menus.map((menu) => {
            const isExpanded = expandedId === menu.richMenuId
            const isBusy = busyId === menu.richMenuId
            return (
              <div
                key={menu.richMenuId}
                className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden"
              >
                <div className="flex flex-col sm:flex-row gap-4 p-4">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : menu.richMenuId)}
                    className="shrink-0 w-full sm:w-40 cursor-pointer hover:opacity-90 transition-opacity"
                    aria-label="プレビューを拡大"
                  >
                    <RichMenuPreview menu={menu} richMenuId={menu.richMenuId} maxWidth={160} />
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            href={`/rich-menus/detail?id=${encodeURIComponent(menu.richMenuId)}`}
                            className="text-sm font-semibold text-gray-900 hover:text-slate-700 truncate"
                          >
                            {menu.name}
                          </Link>
                          {menu.selected && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                              デフォルト
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          チャットバー: <span className="font-mono">{menu.chatBarText}</span>
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {menu.size.width} × {menu.size.height} / {menu.areas.length} エリア
                        </p>
                        <p className="text-[10px] text-gray-300 mt-1 font-mono truncate">
                          {menu.richMenuId}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {!menu.selected && (
                          <button
                            onClick={() => handleSetDefault(menu.richMenuId)}
                            disabled={isBusy}
                            className="px-3 py-1.5 text-xs font-medium text-white rounded-md transition-opacity hover:opacity-90 disabled:opacity-50"
                            style={{ backgroundColor: '#0f172a' }}
                          >
                            {isBusy ? '設定中...' : 'デフォルトに設定'}
                          </button>
                        )}
                        <Link
                          href={`/rich-menus/new?edit=${encodeURIComponent(menu.richMenuId)}`}
                          className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                        >
                          編集
                        </Link>
                        <button
                          onClick={() => handleDelete(menu)}
                          disabled={isBusy}
                          className="px-3 py-1.5 text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors disabled:opacity-50"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="bg-gray-50 border-t border-gray-200 p-4 flex justify-center">
                    <RichMenuPreview menu={menu} richMenuId={menu.richMenuId} maxWidth={640} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
