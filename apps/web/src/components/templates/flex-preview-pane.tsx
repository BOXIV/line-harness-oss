'use client'

import FlexPreview from '@/components/flex-preview'

interface FlexPreviewPaneProps {
  json: string
  maxWidth?: number
}

/**
 * Flex preview wrapper that surfaces JSON.parse errors explicitly so
 * editors can fix syntax issues. On valid JSON, defers to FlexPreview.
 */
export default function FlexPreviewPane({ json, maxWidth = 480 }: FlexPreviewPaneProps) {
  if (!json.trim()) {
    return (
      <div className="text-xs text-gray-400 p-3 bg-gray-50 border border-dashed border-gray-200 rounded-lg">
        プレビュー待機中... Flex JSON を入力してください
      </div>
    )
  }

  let parseError: string | null = null
  try {
    JSON.parse(json)
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e)
  }

  if (parseError) {
    return (
      <div className="border border-red-200 bg-red-50 rounded-lg p-3 text-xs text-red-700">
        <p className="font-semibold mb-1">JSON parse error</p>
        <pre className="whitespace-pre-wrap break-all font-mono">{parseError}</pre>
      </div>
    )
  }

  return (
    <div
      className="bg-gray-100 rounded-lg p-4 overflow-auto max-h-[70vh] flex justify-center"
      style={{ minHeight: 200 }}
    >
      <FlexPreview content={json} maxWidth={maxWidth} />
    </div>
  )
}
