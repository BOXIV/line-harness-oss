'use client'

import { useEffect, useMemo, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { validateDraft, type RichMenuDraft } from '@/lib/rich-menu-validate'
import Header from '@/components/layout/header'
import RichMenuEditor from '@/components/rich-menus/rich-menu-editor'

const DEFAULT_DRAFT: RichMenuDraft = {
  name: '',
  chatBarText: 'メニュー',
  selected: true,
  size: { width: 2500, height: 1686 },
  areas: [],
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        const idx = result.indexOf(',')
        resolve(idx >= 0 ? result.slice(idx + 1) : result)
      } else {
        reject(new Error('failed to read file'))
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function NewRichMenuInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const fromId = searchParams.get('from')

  const [draft, setDraft] = useState<RichMenuDraft>(DEFAULT_DRAFT)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [imageType, setImageType] = useState<'image/png' | 'image/jpeg'>('image/png')
  const [imageError, setImageError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitStatus, setSubmitStatus] = useState('')
  const [duplicateLoading, setDuplicateLoading] = useState(Boolean(fromId))

  // 複製モード: 既存メニューから初期化
  useEffect(() => {
    if (!fromId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.richMenus.list()
        if (cancelled) return
        if (res.success) {
          const src = res.data.find((m) => m.richMenuId === fromId)
          if (src) {
            setDraft({
              name: `${src.name} (複製)`.slice(0, 300),
              chatBarText: src.chatBarText,
              selected: src.selected,
              size: src.size,
              areas: src.areas,
            })
          }
        }
      } finally {
        if (!cancelled) setDuplicateLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [fromId])

  const validation = useMemo(() => validateDraft(draft), [draft])

  const handleImage = async (file: File) => {
    setImageError('')
    if (file.size > 1024 * 1024) {
      setImageError(`画像は 1MB 以下にしてください (現在 ${(file.size / 1024).toFixed(0)} KB)`)
      return
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setImageError('PNG / JPEG のみ対応です')
      return
    }
    // 解像度チェック
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.width, h: img.height })
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = dataUrl
    })
    if (dims.w !== draft.size.width || dims.h !== draft.size.height) {
      setImageError(
        `画像サイズが一致しません: 期待 ${draft.size.width}×${draft.size.height}, 実際 ${dims.w}×${dims.h}`,
      )
      // 表示はする（ユーザーがサイズを変えれば一致するかもしれない）
    }
    setImageDataUrl(dataUrl)
    const base64 = await fileToBase64(file)
    setImageBase64(base64)
    setImageType(file.type as 'image/png' | 'image/jpeg')
  }

  const canSubmit = validation.ok && imageBase64 != null && !imageError && !submitting

  const handleSubmit = async () => {
    if (!canSubmit || !imageBase64) return
    setSubmitting(true)
    setSubmitError('')
    setSubmitStatus('リッチメニューを作成中...')

    let createdId: string | null = null
    try {
      // 1. メニュー作成
      const createRes = await api.richMenus.create({
        size: draft.size,
        selected: draft.selected,
        name: draft.name,
        chatBarText: draft.chatBarText,
        areas: draft.areas,
      })
      if (!createRes.success) throw new Error(createRes.error)
      createdId = createRes.data.richMenuId

      // 2. 画像アップロード
      setSubmitStatus('画像をアップロード中...')
      const uploadRes = await api.richMenus.uploadImage(createdId, imageBase64, imageType)
      if (!uploadRes.success) {
        // 画像アップ失敗 → 孤児メニューを削除
        await api.richMenus.delete(createdId).catch(() => undefined)
        throw new Error('画像アップロードに失敗しました: ' + uploadRes.error)
      }

      // 3. デフォルト設定（任意）
      if (draft.selected) {
        setSubmitStatus('デフォルトに設定中...')
        const defaultRes = await api.richMenus.setDefault(createdId)
        if (!defaultRes.success) {
          // デフォルト設定失敗は致命的でない、警告のみ
          setSubmitError(`作成は成功しましたがデフォルト設定に失敗: ${defaultRes.error}`)
          setSubmitStatus('')
          setSubmitting(false)
          router.push('/rich-menus')
          return
        }
      }

      setSubmitStatus('完了しました')
      router.push('/rich-menus')
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
      setSubmitStatus('')
      setSubmitting(false)
    }
  }

  if (duplicateLoading) {
    return (
      <div>
        <Header title="リッチメニューを複製中..." />
        <div className="text-sm text-gray-500">既存のメニューを読み込んでいます。</div>
      </div>
    )
  }

  return (
    <div>
      <Header
        title={fromId ? 'リッチメニューを複製して作成' : 'リッチメニューを新規作成'}
        description="LINE Platform 上にリッチメニューを新規登録します。作成後は画像とエリア定義の変更ができないので、内容を確認してから作成してください。"
        action={
          <Link
            href="/rich-menus"
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            ← 一覧に戻る
          </Link>
        }
      />

      <RichMenuEditor
        value={draft}
        onChange={setDraft}
        imageUrl={imageDataUrl}
        onImageSelected={handleImage}
        validation={validation}
        disabled={submitting}
      />

      {imageError && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
          ⚠️ {imageError}
        </div>
      )}

      {submitError && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {submitError}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3 sticky bottom-4 bg-white/95 backdrop-blur-sm rounded-lg shadow-md border border-gray-200 p-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-5 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#0f172a' }}
        >
          {submitting ? (submitStatus || '作成中...') : 'リッチメニューを作成'}
        </button>
        <Link
          href="/rich-menus"
          className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
        >
          キャンセル
        </Link>
        {!imageBase64 && (
          <span className="text-xs text-gray-500">画像を選択してください</span>
        )}
      </div>
    </div>
  )
}

export default function NewRichMenuPage() {
  return (
    <Suspense fallback={<div className="text-sm text-gray-500">読み込み中...</div>}>
      <NewRichMenuInner />
    </Suspense>
  )
}
