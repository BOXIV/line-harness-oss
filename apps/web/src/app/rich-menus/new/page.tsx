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

// dataURL を読み込んで自然解像度を返す（サイズ整合チェック用）
function measureImage(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.width, h: img.height })
    img.onerror = () => reject(new Error('failed to load image'))
    img.src = dataUrl
  })
}

// LINE から取得した画像 Blob を、キャンバス表示用 dataURL と再アップロード用 base64 に変換する。
async function blobToImage(
  blob: Blob,
): Promise<{ dataUrl: string; base64: string; type: 'image/png' | 'image/jpeg' }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  const idx = dataUrl.indexOf(',')
  const base64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
  // blob.type は LINE のヘッダ欠落時に png へ丸められるため、FileReader が付けた data URI prefix を優先する。
  const type = /^data:image\/jpe?g/i.test(dataUrl) ? 'image/jpeg' : 'image/png'
  return { dataUrl, base64, type }
}

function NewRichMenuInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const fromId = searchParams.get('from')
  const editId = searchParams.get('edit')
  // edit = 既存メニューを差し替え（旧メニューは削除）/ from = 内容を引き継いだ別メニューを新規作成
  const sourceId = editId ?? fromId
  const isEdit = Boolean(editId)

  const [draft, setDraft] = useState<RichMenuDraft>(DEFAULT_DRAFT)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [imageType, setImageType] = useState<'image/png' | 'image/jpeg'>('image/png')
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageLoadFailed, setImageLoadFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitStatus, setSubmitStatus] = useState('')
  const [sourceLoading, setSourceLoading] = useState(Boolean(sourceId))
  // 編集対象がアカウント既定メニューか（menu.selected ではなく LINE の実値で判定）
  const [sourceWasDefault, setSourceWasDefault] = useState(false)
  // 「アカウントの既定メニューにする」（= LINE の setDefaultRichMenu、全友だちに即時反映）。
  // ⚠️ LINE の `selected`（チャットを開いたときメニューが展開表示されるか）とは別物。
  //    以前は selected のチェックを既定化の合図に使っていて、新規作成の初期値が selected=true
  //    だったため、**メニューを作るたびに全友だちの既定メニューが差し替わっていた**（2026-08-29 監査）。
  //    新規/複製は必ず OFF。編集は「元が既定だったか」を LINE の実値から引き継ぐ。
  const [setAsDefault, setSetAsDefault] = useState(false)

  // 複製 / 編集モード: 既存メニューのメタ情報・エリア・画像を初期値として読み込む
  useEffect(() => {
    if (!sourceId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.richMenus.list()
        if (cancelled) return
        if (res.success) {
          const src = res.data.find((m) => m.richMenuId === sourceId)
          if (src) {
            setDraft({
              name: isEdit ? src.name : `${src.name} (複製)`.slice(0, 300),
              chatBarText: src.chatBarText,
              // 複製では既定を引き継がない（元のデフォルトを奪わない）。編集では元の表示状態を踏襲。
              selected: isEdit ? src.selected : false,
              size: src.size,
              areas: src.areas,
            })
          }
        }
        // 編集時は「旧メニューが本当にアカウント既定か」を LINE の実値で確認する。
        if (isEdit) {
          try {
            const def = await api.richMenus.getDefault()
            if (!cancelled && def.success) {
              const wasDefault = def.data.richMenuId === sourceId
              setSourceWasDefault(wasDefault)
              setSetAsDefault(wasDefault)
            }
          } catch {
            // 取得失敗時は selected を控えめなフォールバックにする（喪失より誤再設定の方が軽微）
          }
        }
        // 画像本体は LINE からプロキシ取得し、キャンバス表示 + 再アップロード用に保持する。
        // （LINE のリッチメニューは作成時に必ず画像が要るため、編集/複製でも引き継ぐ）
        try {
          const blob = await api.richMenus.fetchImage(sourceId)
          if (!cancelled && blob) {
            const { dataUrl, base64, type } = await blobToImage(blob)
            const dims = await measureImage(dataUrl).catch(() => null)
            if (!cancelled) {
              setImageDataUrl(dataUrl)
              setImageBase64(base64)
              setImageType(type)
              if (dims) setImageDims(dims)
            }
          } else if (!cancelled && !blob) {
            setImageLoadFailed(true) // 404 / 画像未登録
          }
        } catch {
          if (!cancelled) setImageLoadFailed(true)
        }
      } finally {
        if (!cancelled) setSourceLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [sourceId, isEdit])

  const validation = useMemo(() => validateDraft(draft), [draft])

  // 画像の自然解像度と現在のサイズ設定の不一致（編集中にサイズを変えても反応する）
  const sizeMismatch =
    imageDims != null && (imageDims.w !== draft.size.width || imageDims.h !== draft.size.height)

  const handleImage = async (file: File) => {
    setImageError('')
    setImageLoadFailed(false)
    if (file.size > 1024 * 1024) {
      setImageError(`画像は 1MB 以下にしてください (現在 ${(file.size / 1024).toFixed(0)} KB)`)
      return
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setImageError('PNG / JPEG のみ対応です')
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const dims = await measureImage(dataUrl).catch(() => null)
    setImageDataUrl(dataUrl)
    const base64 = await fileToBase64(file)
    setImageBase64(base64)
    setImageType(file.type as 'image/png' | 'image/jpeg')
    setImageDims(dims) // サイズ不一致は sizeMismatch で派生判定（サイズを直せば自動で解消）
  }

  const canSubmit = validation.ok && imageBase64 != null && !imageError && !sizeMismatch && !submitting

  const handleSubmit = async () => {
    if (!canSubmit || !imageBase64) return
    setSubmitting(true)
    setSubmitError('')
    setSubmitStatus(isEdit ? '新しいメニューを作成中...' : 'リッチメニューを作成中...')

    // 既定への設定は「アカウントの既定メニューにする」チェックだけで決める（selected とは無関係）。
    // 編集で元が既定だった場合は初期値 ON（差し替え後に既定が消えないように）。
    const shouldSetDefault = setAsDefault

    let createdId: string | null = null
    try {
      // 1. メニュー作成（LINE は作成後の編集不可なので、編集 = 新規作成 + 差し替え）
      const createRes = await api.richMenus.create({
        size: draft.size,
        selected: draft.selected,
        name: draft.name,
        chatBarText: draft.chatBarText,
        areas: draft.areas,
      })
      if (!createRes.success) throw new Error(createRes.error)
      createdId = createRes.data.richMenuId

      // 2. 画像アップロード（失敗 → 孤児メニューを削除し中断。旧メニューには触れない）
      setSubmitStatus('画像をアップロード中...')
      const uploadRes = await api.richMenus.uploadImage(createdId, imageBase64, imageType)
      if (!uploadRes.success) {
        await api.richMenus.delete(createdId).catch(() => undefined)
        throw new Error('画像アップロードに失敗しました: ' + uploadRes.error)
      }

      // 3. デフォルト設定。編集で失敗した場合は、旧メニュー（まだ現行既定の可能性）を消さないよう中断する。
      //    この時点では新メニューは未マッピング・未既定なので、孤児として安全に削除できる。
      if (shouldSetDefault) {
        setSubmitStatus('デフォルトに設定中...')
        const defaultRes = await api.richMenus.setDefault(createdId)
        if (!defaultRes.success) {
          if (isEdit) {
            await api.richMenus.delete(createdId).catch(() => undefined)
            throw new Error(
              'デフォルト設定に失敗したため差し替えを中断しました（旧メニューは保持されます）: ' + defaultRes.error,
            )
          }
          // 新規/複製では旧メニュー削除が無いので警告のみで継続
          setSubmitError(`作成は成功しましたがデフォルト設定に失敗: ${defaultRes.error}`)
        }
      }

      // 4. 編集モード: ステータス連動の付け替え + 旧メニュー削除
      if (isEdit && sourceId && sourceId !== createdId) {
        setSubmitStatus('ステータス連動の引き継ぎ中...')
        const rebindRes = await api.richMenus.autoSwitch
          .rebind({ fromRichMenuId: sourceId, toRichMenuId: createdId, toRichMenuName: draft.name })
          .catch((e) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (!rebindRes.success) {
          // 付け替え失敗時は旧メニューを残して中断（自動切替が壊れないように）。
          // 新メニューは既定化済みの可能性があるため削除しない。
          throw new Error('ステータス連動の引き継ぎに失敗しました: ' + rebindRes.error)
        }

        setSubmitStatus('旧メニューを削除中...')
        const delRes = await api.richMenus
          .delete(sourceId)
          .catch((e) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (!delRes.success) {
          // 旧メニュー削除失敗は致命的でない（新メニューは有効）。警告のみ。
          setSubmitError(`差し替えは完了しましたが旧メニューの削除に失敗しました（手動で削除してください）: ${delRes.error}`)
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

  if (sourceLoading) {
    return (
      <div>
        <Header title={isEdit ? 'リッチメニューを読み込み中...' : 'リッチメニューを複製中...'} />
        <div className="text-sm text-gray-500">既存のメニューを読み込んでいます。</div>
      </div>
    )
  }

  const title = isEdit
    ? 'リッチメニューを編集'
    : fromId
    ? 'リッチメニューを複製して作成'
    : 'リッチメニューを新規作成'

  return (
    <div>
      <Header
        title={title}
        description={
          isEdit
            ? 'LINE 仕様上リッチメニューは直接編集できないため、内容を引き継いだ新しいメニューを作成して差し替えます。'
            : 'LINE Platform 上にリッチメニューを新規登録します。作成後は画像とエリア定義の変更ができないので、内容を確認してから作成してください。'
        }
        action={
          <Link
            href="/rich-menus"
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            ← 一覧に戻る
          </Link>
        }
      />

      {isEdit && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs space-y-1">
          <p className="font-semibold">⚠️ 「保存」すると新しいリッチメニュー（別の richMenuId）に差し替わります。</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>アカウント既定だった場合は新メニューを自動でデフォルトに再設定します（失敗時は差し替えを中止し旧メニューを保持）。</li>
            <li>ステータス連動マッピングは新メニューへ引き継ぎ、対象の友だちは次回ステータス変更時に新メニューへ切り替わります。</li>
            <li>手動で個別割り当てした友だちは自動では切り替わりません（旧メニュー削除後はデフォルトに戻ります）。必要に応じて再割り当てしてください。</li>
            <li>他メニューの richmenuswitch がこのメニューを alias 経由で参照している場合、alias の張り替えは手動で行ってください（本ツールは alias を管理しません）。</li>
            <li>引き継ぎ完了後、旧メニューは LINE Platform から削除されます。</li>
          </ul>
        </div>
      )}

      {sourceId && imageLoadFailed && !imageBase64 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
          元の画像を取得できませんでした。差し替え用の画像を選択してください。
        </div>
      )}

      <RichMenuEditor
        value={draft}
        onChange={setDraft}
        imageUrl={imageDataUrl}
        onImageSelected={handleImage}
        validation={validation}
        disabled={submitting}
      />

      {/* 既定メニュー（LINE の setDefaultRichMenu）。selected（展開表示）とは別の操作。 */}
      <div className="mt-4 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <label className="inline-flex items-start gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={setAsDefault}
            onChange={(e) => setSetAsDefault(e.target.checked)}
            disabled={submitting}
            className="mt-0.5 rounded"
          />
          <span>
            アカウントの既定メニューにする
            <span className="block text-xs text-gray-500 mt-0.5">
              ON にすると保存直後に <strong>全友だち</strong> の既定メニューがこのメニューに切り替わります。
              個別に設定されたメニューやステータス連動は影響を受けません。
              {isEdit && sourceWasDefault && ' 編集元は現在の既定メニューです（OFF にすると既定が外れます）。'}
            </span>
          </span>
        </label>
      </div>

      {imageError && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
          ⚠️ {imageError}
        </div>
      )}

      {sizeMismatch && imageDims && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
          ⚠️ 画像サイズが一致しません: 期待 {draft.size.width}×{draft.size.height}, 実際 {imageDims.w}×{imageDims.h}
          （サイズを合わせるか、一致する画像を選択してください）
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
          {submitting
            ? (submitStatus || '処理中...')
            : isEdit
            ? '保存して差し替え'
            : 'リッチメニューを作成'}
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
