'use client'

/**
 * 撮影予約・シフトロジック解説モーダル
 *
 * スタッフシフト管理画面の右上ボタンから開く。撮影予約〜スタッフアサインの
 * 運用ロジックを、実装（apps/worker/src/utils/area.ts, staff-assignment.ts,
 * routes/booking.ts, routes/booking-requests.ts, routes/staff-availability.ts,
 * migration 014/912）に合わせて記載。
 *
 * 元となった要件書 line/schedule-adjustment/booking-system-spec.html を実装と突合し、
 * リードタイム(3日/7日前締切)・work_area 固定エリア・ロール権限・cancelled 等を反映済み。
 * デザインは Apple 風のリキッドグラス（半透明＋backdrop-blur）で再構成。
 */

import { useEffect } from 'react'
import { AREA_IDS, AREA_LABELS, AREA_PREFECTURES } from '@/lib/area-meta'

const AREA_TAG: Record<string, string> = {
  shutoken: 'bg-blue-100/70 text-blue-700 ring-blue-200/60',
  chubu: 'bg-amber-100/70 text-amber-700 ring-amber-200/60',
  kinki: 'bg-rose-100/70 text-rose-700 ring-rose-200/60',
  kanto_suburban: 'bg-emerald-100/70 text-emerald-700 ring-emerald-200/60',
  kyushu: 'bg-violet-100/70 text-violet-700 ring-violet-200/60',
  other: 'bg-slate-200/70 text-slate-600 ring-slate-300/60',
}

function AreaTag({ id }: { id: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${AREA_TAG[id] ?? AREA_TAG.other}`}>
      {AREA_LABELS[id] ?? id}
    </span>
  )
}

/** 半透明ガラスのセクションカード */
function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/60 bg-white/55 p-5 shadow-sm ring-1 ring-black/[0.03] backdrop-blur-md">
      <h3 className="mb-3.5 flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-900">
        <span className="text-base" aria-hidden>{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** 数値・ラベルの小カード */
function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 backdrop-blur-md ${accent ? 'border-sky-200/70 bg-sky-50/70' : 'border-white/70 bg-white/60'}`}>
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-[17px] font-bold tracking-tight ${accent ? 'text-sky-700' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  )
}

function Pill({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'accent' }) {
  return (
    <div
      className={`rounded-2xl border px-3.5 py-2 text-center text-[12px] font-semibold shadow-sm backdrop-blur ${
        tone === 'accent'
          ? 'border-sky-300/70 bg-sky-500/90 text-white'
          : 'border-white/70 bg-white/70 text-slate-700'
      }`}
    >
      {children}
    </div>
  )
}

function Arrow() {
  return <span className="select-none text-slate-300" aria-hidden>→</span>
}

export default function ShiftLogicModal({ onClose }: { onClose: () => void }) {
  // Esc で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="撮影予約・シフトロジック"
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/60 bg-white/75 shadow-[0_30px_80px_-20px_rgba(15,23,42,0.5)] ring-1 ring-black/5 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 上部の光沢（リキッドグラスのシーン） */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/70 to-transparent" aria-hidden />

        {/* Sticky ヘッダー */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-white/50 bg-white/60 px-6 py-4 backdrop-blur-xl">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight text-slate-900">
              <span aria-hidden>📷</span> 撮影予約・シフトロジック
            </h2>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              出品者の車両撮影日程を LINE で自動調整する仕組みと運用ルール
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full border border-white/70 bg-white/70 p-2 text-slate-500 shadow-sm backdrop-blur transition hover:bg-white hover:text-slate-800"
            aria-label="閉じる"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* スクロール本文 */}
        <div className="relative space-y-4 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">

          {/* 概要フロー */}
          <Section icon="🎯" title="全体の流れ">
            <p className="mb-4 text-[13px] leading-relaxed text-slate-600">
              出品希望者が Web フォームを送信 → Notion に自動転記 → トリガーで顧客情報を取得 →
              専用予約リンクを LINE 送信 → 出品者が日程を申請 → 管理者が承認、という流れで撮影日を確定する。
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Pill>Web フォーム<br /><span className="text-[10px] font-normal opacity-70">→ Notion 転記</span></Pill>
              <Arrow />
              <Pill>Notion API<br /><span className="text-[10px] font-normal opacity-70">顧客情報取得</span></Pill>
              <Arrow />
              <Pill tone="accent">LINE 送信<br /><span className="text-[10px] font-normal opacity-80">専用リンク</span></Pill>
              <Arrow />
              <Pill>LIFF 認証<br /><span className="text-[10px] font-normal opacity-70">自動 / Login</span></Pill>
              <Arrow />
              <Pill>日程選択<br /><span className="text-[10px] font-normal opacity-70">+ ナンバー入力</span></Pill>
              <Arrow />
              <Pill tone="accent">管理者承認<br /><span className="text-[10px] font-normal opacity-80">スタッフ変更可</span></Pill>
            </div>
          </Section>

          {/* 基本ルール */}
          <Section icon="⏱️" title="予約の基本ルール">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <StatCard label="スロット単位" value="120分" sub="2時間枠" />
              <StatCard label="営業時間 (通常期 9〜4月)" value="10:00–16:00" />
              <StatCard label="営業時間 (夏期 5〜8月)" value="10:00–18:00" sub="16:00枠が追加" />
              <StatCard label="予約方式" value="申請 → 承認制" />
            </div>
          </Section>

          {/* リードタイム（新規・実装に合わせて明記） */}
          <Section icon="🗓️" title="予約可能期間・申込締切（リードタイム）">
            <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
              直前の申込は承認確認と撮影スタッフの派遣手配が間に合わないため、
              エリアごとに最短リードタイム（申込締切）を設けている。締切より手前の日付は
              ピッカーに表示されず、直接申請してもサーバ側で却下される。
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <StatCard label="通常エリア（巡回5エリア）" value="撮影日の3日前まで" sub="本日+3日 〜 最大4週間先(28日)" accent />
              <StatCard label="その他の県" value="撮影日の7日前まで" sub="本日+7日 〜 90日先" accent />
            </div>
            <div className="mt-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-[12px] leading-relaxed text-amber-900 backdrop-blur">
              通常エリアは <strong>3日前締切</strong>（本日を0日目として3日後以降のみ選択可）を
              ピッカー・スロット表示・確認画面・申請確定の各段でガード。その他の県は定期巡回が
              ないため <strong>7日前締切</strong> と長めに設定している。
            </div>
          </Section>

          {/* エリア定義 */}
          <Section icon="🗺️" title="エリア定義（6エリア）">
            <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
              出品者の都道府県とスタッフの稼働エリアをマッチングして空き枠を表示する。
            </p>
            <div className="overflow-hidden rounded-2xl border border-white/70">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-white/60 text-left text-slate-500">
                    <th className="px-3.5 py-2 font-semibold">エリア</th>
                    <th className="px-3.5 py-2 font-semibold">対象都道府県</th>
                    <th className="px-3.5 py-2 font-semibold">予約方式</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/60">
                  {AREA_IDS.map((id) => (
                    <tr key={id} className="bg-white/30">
                      <td className="px-3.5 py-2"><AreaTag id={id} /></td>
                      <td className="px-3.5 py-2 text-slate-700">{AREA_PREFECTURES[id].join('、')}</td>
                      <td className="px-3.5 py-2 text-slate-600">空きスロット選択</td>
                    </tr>
                  ))}
                  <tr className="bg-white/30">
                    <td className="px-3.5 py-2"><AreaTag id="other" /></td>
                    <td className="px-3.5 py-2 text-slate-700">上記以外のすべての県</td>
                    <td className="px-3.5 py-2 font-semibold text-slate-700">3候補入力（必須）</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          {/* スタッフのシフト運用（work_area 固定に修正） */}
          <Section icon="📅" title="スタッフのシフト運用">
            <ul className="space-y-2 text-[13px] leading-relaxed text-slate-700">
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                <span>
                  エリアは <strong>スタッフごとに固定の稼働エリア（work_area）</strong> が割り当てられ、
                  マネージャーが「スタッフ管理」で事前設定する。
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                <span>
                  撮影スタッフはシフト登録時に<strong>エリアを選ばない</strong>（稼働エリアが自動適用）。
                  登録するのは <strong>日付＋120分の時間枠</strong>のみ。work_area 未設定のスタッフは登録不可。
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                <span>登録すると、そのエリアの出品者の予約画面に空き枠として反映される。</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                <span>
                  結果として1スタッフの全シフトは常に同一エリア＝<strong>同日にエリアが混在しない</strong>。
                  Google Calendar 連携はなく管理画面のみで完結する。
                </span>
              </li>
            </ul>
            <div className="mt-3 rounded-2xl border border-slate-200/70 bg-slate-50/70 px-4 py-3 text-[12px] leading-relaxed text-slate-600 backdrop-blur">
              ※「1日1エリア」はハード制約ではなく、スタッフ自己登録時に work_area を強制することで
              担保される運用前提。管理者が代理でシフトを作る場合はエリアを任意指定でき、同日複数エリアを
              防ぐDB制約はない（運用で担保）。
            </div>
          </Section>

          {/* 自動アサイン（集約） */}
          <Section icon="🧠" title="スタッフ自動アサイン（集約ロジック）">
            <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
              同日・同エリアに複数スタッフが対応可能な場合、なるべく同じスタッフに予約を集約して
              他スタッフの稼働日を減らす。
            </p>
            <div className="rounded-2xl bg-slate-900/95 px-5 py-4 font-mono text-[12px] leading-relaxed text-slate-100 shadow-inner">
              <div className="text-slate-400">// 出品者がスロットを選択した時の自動アサイン</div>
              <div className="mt-2"><span className="text-sky-300">1.</span> 空きスタッフ一覧を取得<span className="text-slate-400">（移動バッファで使えないスタッフは除外）</span></div>
              <div><span className="text-sky-300">2.</span> 各スタッフの<span className="text-emerald-300">「同日・同エリアの既存予約数」</span>をカウント</div>
              <div><span className="text-sky-300">3.</span> 既存予約数が<span className="text-emerald-300">最も多いスタッフを優先</span>（＝集約）</div>
              <div className="pl-5 text-slate-400">→ 同数の場合は staff_id 昇順で安定ソート</div>
              <div><span className="text-sky-300">4.</span> アサイン結果を booking_requests.staff_id に記録</div>
              <div className="mt-2 text-amber-300">※ 管理者は承認前にスタッフを変更可能</div>
            </div>
            <div className="mt-3 rounded-2xl border border-sky-200/60 bg-sky-50/60 px-4 py-3 text-[12px] leading-relaxed text-slate-700 backdrop-blur">
              <strong>重要:</strong> 集約は「アサイン先の選択」ロジックであり、枠をブロックすることではない。
              1人でも空きスタッフがいれば、出品者には常に「予約可能」と表示される。
            </div>
          </Section>

          {/* 移動時間バッファ */}
          <Section icon="🚗" title="移動時間バッファ（同一エリア内・別県）">
            <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
              同一スタッフの<strong>直前の隣接枠に別の県</strong>の予約（pending / approved）が入っている場合、
              そのスタッフの次の1枠を自動ブロックする。<strong>同じ県</strong>なら連続予約OK（県内移動は短い前提）。
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/70 bg-white/60 p-3.5 text-[12px] leading-relaxed text-slate-700 backdrop-blur">
                <div className="mb-1 font-semibold text-slate-900">ブロックされる例</div>
                スタッフXの 12:00–14:00 が<strong>埼玉県</strong>の予約 → 続く 14:00–16:00 に<strong>千葉県</strong>を入れると
                移動が必要なため X の当該枠はブロック。ただし別スタッフYが空いていれば予約可（Yにアサイン）。
              </div>
              <div className="rounded-2xl border border-white/70 bg-white/60 p-3.5 text-[12px] leading-relaxed text-slate-700 backdrop-blur">
                <div className="mb-1 font-semibold text-slate-900">ブロックされない例</div>
                直前枠と<strong>同じ県</strong>なら同一スタッフでも連続OK。1人でも空きスタッフがいれば
                出品者には「予約可能」として表示される。
              </div>
            </div>
          </Section>

          {/* 承認フロー & ステータス（cancelled 追加・approved 修正） */}
          <Section icon="✅" title="承認フローとステータス">
            <div className="overflow-hidden rounded-2xl border border-white/70">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-white/60 text-left text-slate-500">
                    <th className="px-3.5 py-2 font-semibold">ステータス</th>
                    <th className="px-3.5 py-2 font-semibold">意味 / 操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/60">
                  <tr className="bg-white/30 align-top">
                    <td className="px-3.5 py-2"><span className="rounded-full bg-indigo-100/70 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200/60">pending_invite</span></td>
                    <td className="px-3.5 py-2 text-slate-600">招待リンク送信済み。出品者の日程選択待ち。</td>
                  </tr>
                  <tr className="bg-white/30 align-top">
                    <td className="px-3.5 py-2"><span className="rounded-full bg-amber-100/70 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200/60">pending</span></td>
                    <td className="px-3.5 py-2 text-slate-600">出品者が日程を申請済み。承認 / 却下、担当スタッフ変更、スロット変更、メモ追加が可能。<br /><span className="text-slate-400">※ スロット確保（is_booked=1）は申請時点で原子的に実行済み（二重予約防止）。</span></td>
                  </tr>
                  <tr className="bg-white/30 align-top">
                    <td className="px-3.5 py-2"><span className="rounded-full bg-emerald-100/70 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200/60">approved</span></td>
                    <td className="px-3.5 py-2 text-slate-600">撮影日確定。出品者へ LINE 通知（🎉 日時・お客様・ナンバー下4桁）。</td>
                  </tr>
                  <tr className="bg-white/30 align-top">
                    <td className="px-3.5 py-2"><span className="rounded-full bg-rose-100/70 px-2 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200/60">rejected</span></td>
                    <td className="px-3.5 py-2 text-slate-600">却下（日程再調整が必要）。スロットを開放し、出品者へ再調整案内を LINE 通知。</td>
                  </tr>
                  <tr className="bg-white/30 align-top">
                    <td className="px-3.5 py-2"><span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300/60">cancelled</span></td>
                    <td className="px-3.5 py-2 text-slate-600">確定済み日程のキャンセル（雨天中止等）。<strong>承認済み予約のみ</strong>キャンセル可。スロットを開放し、出品者へキャンセル通知＋再調整案内を送る。</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-3 rounded-2xl border border-slate-200/70 bg-slate-50/70 px-4 py-3 text-[12px] leading-relaxed text-slate-600 backdrop-blur">
              「その他の県」の承認は、出品者が提出した<strong>3候補から管理者が1つ選んで</strong>スタッフをアサインし承認する。
            </div>
          </Section>

          {/* ロールと権限（新規） */}
          <Section icon="👥" title="ロールと権限">
            <div className="overflow-hidden rounded-2xl border border-white/70">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-white/60 text-left text-slate-500">
                    <th className="px-3.5 py-2 font-semibold">操作</th>
                    <th className="px-3.5 py-2 font-semibold">実行できるロール</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/60">
                  <tr className="bg-white/30"><td className="px-3.5 py-2 text-slate-700">承認・却下・キャンセル</td><td className="px-3.5 py-2 font-medium text-slate-800">owner / admin / manager</td></tr>
                  <tr className="bg-white/30"><td className="px-3.5 py-2 text-slate-700">予約の削除</td><td className="px-3.5 py-2 font-medium text-slate-800">admin / owner のみ</td></tr>
                  <tr className="bg-white/30"><td className="px-3.5 py-2 text-slate-700">シフト登録・編集</td><td className="px-3.5 py-2 font-medium text-slate-800">全ロール（staff は自分の稼働エリアのみ）</td></tr>
                  <tr className="bg-white/30"><td className="px-3.5 py-2 text-slate-700">撮影スタッフ（staff）</td><td className="px-3.5 py-2 text-slate-600">自分担当予約の閲覧・編集のみ。承認 / 却下 / キャンセル / 担当変更は不可。</td></tr>
                </tbody>
              </table>
            </div>
          </Section>

          {/* 技術メモ */}
          <div className="rounded-2xl border border-white/60 bg-white/40 px-4 py-3 text-[11px] leading-relaxed text-slate-500 backdrop-blur">
            <span className="font-semibold text-slate-600">技術メモ:</span>{' '}
            予約ページは Hono SSR + Cloudflare D1 + Notion API + LINE Login / Messaging API（既存 Worker を流用）。
            テーブルは migration <code className="rounded bg-slate-200/60 px-1">014_booking_system.sql</code>、
            稼働エリアは <code className="rounded bg-slate-200/60 px-1">912_staff_work_area.sql</code>（staff_members.work_area）。
            予約ページ認証は Cookie <code className="rounded bg-slate-200/60 px-1">__booking_session</code> と
            <code className="rounded bg-slate-200/60 px-1">POST /api/liff/booking-auth</code>。
          </div>
        </div>
      </div>
    </div>
  )
}
