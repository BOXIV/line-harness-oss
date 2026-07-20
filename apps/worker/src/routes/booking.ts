/**
 * 撮影予約ページ（出品者向け SSR）
 *
 * URL: /booking?token=<invite_token>
 *
 * フロー:
 *  1. /booking → 招待トークン検証 → エリア表示 + 日付ピッカー
 *  2. /booking/slots → 選択日の空きスロット表示
 *  3. /booking/confirm → 確認画面 + ナンバープレート4桁入力
 *  4. /booking/submit → 予約申請作成 → スタッフ自動アサイン → LINE通知
 *  5. /booking/complete → 完了画面
 */

import { Hono } from 'hono';
import {
  getBookingRequestByToken,
  updateBookingRequest,
  getStaffAvailabilityById,
  markSlotBooked,
  getFriendById,
  type BookingRequestRow,
} from '@line-crm/db';
import {
  AREA_LABELS,
  BOOKING_MIN_LEAD_DAYS,
  generateSlots,
  getDateRange,
  getMinBookingDate,
  isValidDateString,
  parseJstDate,
  formatJstDateLabel,
  type AreaId,
} from '../utils/area.js';
import {
  pickStaffForSlot,
  getAvailableSlotsForSeller,
  findDatesWithAvailability,
} from '../utils/staff-assignment.js';
import { bookingAuthMiddleware } from '../middleware/booking-auth.js';
import type { Env } from '../index.js';
import { firstSentMessageId } from '../utils/quote.js';

const booking = new Hono<Env>();

// すべての /booking* に認証ミドルウェアを適用（Cookieがあれば検証）
booking.use('/booking', bookingAuthMiddleware);
booking.use('/booking/*', bookingAuthMiddleware);

// ─── ヘルパー ──────────────────────────────────────────────

function htmlLayout(title: string, body: string, opts: { liffId?: string } = {}): string {
  const liffScript = opts.liffId
    ? `<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${escapeHtml(title)} | BOXIV Lightning</title>
<script src="https://cdn.tailwindcss.com"></script>
${liffScript}
<style>
  body { font-family: 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
  .brand { color: #0f172a; }
  .bg-brand { background-color: #0f172a; }
  .border-brand { border-color: #0f172a; }
  /* 日付・時間ピッカー共通スタイル: 横幅を親にぴったり合わせる + iOS の最小幅問題を回避 */
  .picker-input {
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 2.75rem; /* 44px - 日付/時間ピッカーで高さ揃える */
    box-sizing: border-box;
    padding: 0.625rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.5;
    background: #ffffff;
    color: #1e293b;
    -webkit-appearance: none;
    appearance: none;
    font-family: inherit;
  }
  .picker-input:focus {
    outline: none;
    border-color: #0f172a;
  }
</style>
</head>
<body class="bg-gray-50 min-h-screen">
${body}
</body>
</html>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHeader(stepLabel: string): string {
  return `
<header class="bg-brand text-white px-5 py-4 shadow-sm sticky top-0 z-10">
  <div class="max-w-md mx-auto">
    <div class="text-xs opacity-90">BOXIV Lightning</div>
    <div class="text-lg font-bold">📷 撮影日程のご予約</div>
    <div class="text-xs opacity-80 mt-1">${escapeHtml(stepLabel)}</div>
  </div>
</header>`;
}

function renderError(message: string, hint?: string): Response {
  const body = `
${renderHeader('エラー')}
<main class="max-w-md mx-auto px-5 py-10">
  <div class="bg-white rounded-2xl p-6 shadow-sm border border-red-200">
    <div class="text-3xl mb-3">⚠️</div>
    <h1 class="text-base font-bold text-gray-900 mb-2">${escapeHtml(message)}</h1>
    ${hint ? `<p class="text-sm text-gray-600">${escapeHtml(hint)}</p>` : ''}
  </div>
</main>`;
  return new Response(htmlLayout('エラー', body), {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
}

/** 既に予約申請済み（pending/approved）の友好的な表示。二重送信や「戻る」での再到達時に、
 *  エラーではなくこの受付済みページを返す（誤って「既に申請済み」エラーに見せない）。 */
function renderAlreadyBooked(status: string): Response {
  const label = status === 'approved' ? '承認済み' : '確認中';
  const body = `
${renderHeader('予約済み')}
<main class="max-w-md mx-auto px-5 py-10">
  <div class="bg-white rounded-2xl p-6 shadow-sm">
    <div class="text-3xl mb-3">✅</div>
    <h1 class="text-base font-bold text-gray-900 mb-2">予約申請を受け付けています</h1>
    <p class="text-sm text-gray-600">現在のステータス: <span class="font-bold">${label}</span></p>
    <p class="text-xs text-gray-500 mt-3">変更はLINEで担当者にご連絡ください。</p>
  </div>
</main>`;
  return new Response(htmlLayout('予約済み', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
}

function renderAuthRequired(token: string, c: { env: Env['Bindings']; req: { url: string } }): Response {
  // LINE Login OAuth に直接リダイレクト（/auth/line はモバイル時に LIFF URL へ飛ばしてしまうためバイパス）
  // state に redirect を埋め込み、/auth/callback で /booking?token=xxx に戻す
  const baseUrl = new URL(c.req.url).origin;
  const callbackUrl = `${baseUrl}/auth/callback`;
  const redirectUrl = `/booking?token=${token}`;

  const state = btoa(
    JSON.stringify({
      ref: '',
      redirect: redirectUrl,
      gclid: '',
      fbclid: '',
      twclid: '',
      ttclid: '',
      utmSource: '',
      utmMedium: '',
      utmCampaign: '',
      account: '',
      uid: '',
    }),
  );

  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', c.env.LINE_LOGIN_CHANNEL_ID);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  // BOXIV: prod Login channel 2010320277 に email スコープが無いため除外
  loginUrl.searchParams.set('scope', 'profile openid');
  loginUrl.searchParams.set('bot_prompt', 'normal');
  loginUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: { Location: loginUrl.toString() },
  });
}

/**
 * 最短リードタイム（BOOKING_MIN_LEAD_DAYS）より手前の日付を弾く共通エラー。
 * 承認確認・撮影スタッフ派遣の準備が間に合わないため受付不可（＝3日前締切）。
 * 日付ピッカーで直近日を非表示にしていても、URL直打ち/戻る操作/POST偽装で
 * 直近日が入り込むため、slots・confirm・submit の各段でこのガードを通す。
 */
function renderTooSoon(): Response {
  return renderError(
    'ご指定の日付はご予約いただけません',
    `撮影日の${BOOKING_MIN_LEAD_DAYS}日前までにお申し込みください（本日から${BOOKING_MIN_LEAD_DAYS}日後以降の日程をお選びください）`,
  );
}

// ─── GET /booking?token=xxx 日付ピッカー ─────────────────────

booking.get('/booking', async (c) => {
  const token = c.req.query('token');
  if (!token) return renderError('リンクが不正です', 'tokenパラメータが必要です');

  const record = await getBookingRequestByToken(c.env.DB, token);
  if (!record) return renderError('予約リンクが見つかりません', 'リンクの有効期限が切れている可能性があります');

  // 「その他の県」は3候補入力フォームへ
  if (record.area === 'other') {
    return c.redirect(`/booking/other?token=${encodeURIComponent(token)}`);
  }

  // 既に予約済みの場合
  if (record.status === 'approved' || record.status === 'pending') {
    return new Response(
      htmlLayout(
        '予約済み',
        `${renderHeader('予約済み')}
<main class="max-w-md mx-auto px-5 py-10">
  <div class="bg-white rounded-2xl p-6 shadow-sm">
    <div class="text-3xl mb-3">✅</div>
    <h1 class="text-base font-bold text-gray-900 mb-2">予約申請を受け付けています</h1>
    <p class="text-sm text-gray-600">現在のステータス: <span class="font-bold">${record.status === 'approved' ? '承認済み' : '確認中'}</span></p>
    <p class="text-xs text-gray-500 mt-3">変更はLINEで担当者にご連絡ください。</p>
  </div>
</main>`,
      ),
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' } },
    );
  }

  // 認証チェック
  const session = c.get('bookingUser');
  if (!session) {
    return renderAuthRequired(token, c);
  }

  // 友だちID整合性チェック
  if (record.friend_id && session.friendId !== record.friend_id) {
    return renderError(
      'この予約リンクは別のお客様用です',
      'お手数ですが、ご自身に届いたリンクからアクセスしてください',
    );
  }

  // 28日先までの日付を生成し、最短リードタイム（本日から BOOKING_MIN_LEAD_DAYS 日後）より
  // 手前の直近日は選択肢に出さない（＝3日前締切）。承認確認・スタッフ派遣手配の時間を確保する。
  const minBookingDate = getMinBookingDate();
  const dates = getDateRange(28).filter((d) => d >= minBookingDate);
  const datesWithAvailability = await findDatesWithAvailability(c.env.DB, record.area, dates);

  const dateButtons = dates
    .map((date) => {
      const p = parseJstDate(date);
      const day = p.day;
      const dayOfWeek = p.dayOfWeekJa;
      const month = p.month;
      const isAvailable = datesWithAvailability.has(date);
      const dayColor = p.dayOfWeek === 0 ? 'text-red-500' : p.dayOfWeek === 6 ? 'text-blue-500' : 'text-gray-700';

      if (isAvailable) {
        return `
<a href="/booking/slots?token=${escapeHtml(token)}&date=${date}"
   class="block bg-white border-2 border-brand rounded-xl p-3 text-center hover:bg-slate-100 transition-colors">
  <div class="text-xs text-gray-500">${month}月</div>
  <div class="text-2xl font-bold text-gray-900">${day}</div>
  <div class="text-xs ${dayColor}">${dayOfWeek}</div>
  <div class="text-[10px] text-brand font-bold mt-1">予約可</div>
</a>`;
      }
      return `
<div class="block bg-gray-100 border-2 border-gray-200 rounded-xl p-3 text-center opacity-60">
  <div class="text-xs text-gray-400">${month}月</div>
  <div class="text-2xl font-bold text-gray-400">${day}</div>
  <div class="text-xs text-gray-400">${dayOfWeek}</div>
  <div class="text-[10px] text-gray-400 mt-1">満枠</div>
</div>`;
    })
    .join('');

  const body = `
${renderHeader('STEP 1 / 3 ・日付を選択')}
<main class="max-w-md mx-auto px-5 py-5">
  <div class="bg-white rounded-2xl p-5 shadow-sm mb-4">
    <div class="text-xs text-gray-500">エリア</div>
    <div class="text-lg font-bold text-gray-900">${escapeHtml(AREA_LABELS[record.area as AreaId] ?? record.area)}</div>
    <div class="text-xs text-gray-500 mt-1">${escapeHtml(record.prefecture)}</div>
  </div>

  <div class="bg-white rounded-2xl p-5 shadow-sm">
    <h2 class="text-sm font-bold text-gray-900 mb-3">📅 撮影希望日を選択してください</h2>
    <div class="grid grid-cols-4 gap-2">
      ${dateButtons}
    </div>
    <p class="text-xs text-gray-500 mt-4">※ 撮影日の${BOOKING_MIN_LEAD_DAYS}日前までにお申し込みください（本日から${BOOKING_MIN_LEAD_DAYS}日後以降・最大4週間先まで）</p>
  </div>
</main>`;

  return new Response(htmlLayout('日付選択', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
});

// ─── GET /booking/slots?token=xxx&date=YYYY-MM-DD ─────────────

booking.get('/booking/slots', async (c) => {
  const token = c.req.query('token');
  const date = c.req.query('date');
  if (!token || !date) return renderError('パラメータが不足しています');
  if (!isValidDateString(date)) return renderError('日付の形式が不正です');
  // 3日前締切: 直近日のスロット閲覧をブロック（ピッカーを介さない直接アクセス対策）
  if (date < getMinBookingDate()) return renderTooSoon();

  const record = await getBookingRequestByToken(c.env.DB, token);
  if (!record) return renderError('予約リンクが見つかりません');
  if (record.area === 'other') return renderError('オンライン予約非対応エリアです');

  const session = c.get('bookingUser');
  if (!session) return renderAuthRequired(token, c);

  const slots = generateSlots(date);
  const availableSlots = await getAvailableSlotsForSeller(
    c.env.DB,
    record.area,
    date,
    slots,
    record.prefecture,
  );

  const slotButtons = availableSlots
    .map((s) => {
      const label = `${s.startTime} 〜 ${s.endTime}`;
      if (s.available) {
        const params = new URLSearchParams({
          token,
          date,
          start: s.startTime,
          end: s.endTime,
        });
        return `
<a href="/booking/confirm?${params.toString()}"
   class="block bg-white border-2 border-brand rounded-xl px-5 py-4 hover:bg-slate-100 transition-colors">
  <div class="flex items-center justify-between">
    <div>
      <div class="text-base font-bold text-gray-900">${label}</div>
      <div class="text-xs text-gray-500 mt-1">2時間枠</div>
    </div>
    <div class="text-brand font-bold text-sm">予約可 →</div>
  </div>
</a>`;
      }
      return `
<div class="block bg-gray-100 border-2 border-gray-200 rounded-xl px-5 py-4 opacity-60">
  <div class="flex items-center justify-between">
    <div>
      <div class="text-base font-bold text-gray-500">${label}</div>
      <div class="text-xs text-gray-400 mt-1">2時間枠</div>
    </div>
    <div class="text-gray-400 font-bold text-sm">満枠</div>
  </div>
</div>`;
    })
    .join('');

  const dateLabel = formatJstDateLabel(date);

  const body = `
${renderHeader('STEP 2 / 3 ・時間を選択')}
<main class="max-w-md mx-auto px-5 py-5">
  <div class="mb-3">
    <a href="/booking?token=${escapeHtml(token)}" class="text-sm text-gray-600 hover:text-brand">← 日付を変更</a>
  </div>
  <div class="bg-white rounded-2xl p-5 shadow-sm mb-4">
    <div class="text-xs text-gray-500">選択した日付</div>
    <div class="text-lg font-bold text-gray-900">${escapeHtml(dateLabel)}</div>
  </div>
  <div class="space-y-3">
    ${slotButtons}
  </div>
</main>`;

  return new Response(htmlLayout('時間選択', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
});

// ─── GET /booking/confirm 確認 + ナンバープレート入力 ──────────

booking.get('/booking/confirm', async (c) => {
  const token = c.req.query('token');
  const date = c.req.query('date');
  const start = c.req.query('start');
  const end = c.req.query('end');
  if (!token || !date || !start || !end) return renderError('パラメータが不足しています');
  // date/start/end はこの後 HTML 属性値やテキストへ展開される。/booking/slots と同様に
  // フォーマットを厳格検証して不正値を弾く（反射XSS対策 — 未検証だと ?date="><script> が
  // 予約者の LINE 認証済みページ上で実行される）。
  if (!isValidDateString(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    return renderError('日時の形式が不正です');
  }
  // 3日前締切: 直近日の確認画面表示をブロック（deep-link/戻る操作対策）
  if (date < getMinBookingDate()) return renderTooSoon();

  const record = await getBookingRequestByToken(c.env.DB, token);
  if (!record) return renderError('予約リンクが見つかりません');
  // 既に申請済みなら確認フォームを再表示しない（申請後に「戻る」で確認フォームへ再到達
  // →再申請で「既に申請済み」エラーになるのを防ぐ）。pending は完了画面（予約完了）へ、
  // approved は受付済みページへ。
  if (record.status === 'pending') {
    return c.redirect(`/booking/complete?token=${encodeURIComponent(token)}`);
  }
  if (record.status === 'approved') {
    return renderAlreadyBooked(record.status);
  }

  const session = c.get('bookingUser');
  if (!session) return renderAuthRequired(token, c);

  const dateLabel = formatJstDateLabel(date);

  const body = `
${renderHeader('STEP 3 / 3 ・確認')}
<main class="max-w-md mx-auto px-5 py-5">
  <div class="mb-3">
    <a href="/booking/slots?token=${escapeHtml(token)}&date=${date}" class="text-sm text-gray-600 hover:text-brand">← 時間を変更</a>
  </div>

  <div class="bg-white rounded-2xl p-5 shadow-sm mb-4">
    <h2 class="text-sm font-bold text-gray-900 mb-3">予約内容</h2>
    <div class="space-y-2 text-sm">
      <div class="flex justify-between border-b border-gray-100 pb-2">
        <span class="text-gray-500">お名前</span>
        <span class="font-bold text-gray-900">${escapeHtml(record.customer_name || session.displayName)} 様</span>
      </div>
      <div class="flex justify-between border-b border-gray-100 pb-2">
        <span class="text-gray-500">エリア</span>
        <span class="font-bold text-gray-900">${escapeHtml(AREA_LABELS[record.area as AreaId] ?? record.area)}</span>
      </div>
      <div class="flex justify-between border-b border-gray-100 pb-2">
        <span class="text-gray-500">日付</span>
        <span class="font-bold text-gray-900">${escapeHtml(dateLabel)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-gray-500">時間</span>
        <span class="font-bold text-gray-900">${start} 〜 ${end}</span>
      </div>
    </div>
  </div>

  <form method="POST" action="/booking/submit" id="bookingForm" novalidate class="space-y-3">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="hidden" name="date" value="${date}">
    <input type="hidden" name="start" value="${start}">
    <input type="hidden" name="end" value="${end}">

    <div class="bg-white rounded-2xl p-5 shadow-sm">
      <h2 class="text-sm font-bold text-gray-900 mb-2">🚗 ナンバープレート下4桁</h2>
      <p class="text-xs text-gray-500 mb-3">撮影当日の車両確認に使用します</p>
      <input
        type="text"
        name="plateNumber"
        inputmode="numeric"
        maxlength="4"
        placeholder="例: 0001"
        class="w-full px-4 py-3 text-2xl text-center font-bold tracking-widest border-2 border-gray-300 rounded-xl focus:border-brand focus:outline-none"
      >
      <p class="text-xs text-gray-500 mt-3 leading-relaxed">
        ※ 1〜3桁の場合は「<span class="font-bold">・</span>」の代わりに「<span class="font-bold text-brand">0</span>」を入力してください<br>
        <span class="text-gray-400">例: ・・・1 → <span class="font-bold text-gray-700">0001</span>　・・12 → <span class="font-bold text-gray-700">0012</span></span>
      </p>
      <p id="err_plateNumber" class="hidden text-xs text-red-600 mt-2 font-bold"></p>
    </div>

    <div id="formError" class="hidden bg-red-50 border-2 border-red-400 rounded-xl p-4 text-sm text-red-700 font-bold"></div>

    <button type="submit" class="w-full bg-brand text-white font-bold py-4 rounded-xl hover:opacity-90 transition-opacity">
      予約を申請する
    </button>
  </form>

  <p class="text-xs text-gray-500 text-center mt-4">
    申請後、担当者の確認をお待ちください<br>
    確定時にLINEでお知らせします
  </p>
</main>
<script>
  const formErrorEl = document.getElementById('formError');
  function setFieldError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '⚠️ ' + msg;
    el.classList.remove('hidden');
  }
  function clearFieldError(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
  }
  function setSummaryError(msg) {
    formErrorEl.textContent = '⚠️ ' + msg;
    formErrorEl.classList.remove('hidden');
  }
  function clearAllErrors() {
    formErrorEl.classList.add('hidden');
    formErrorEl.textContent = '';
    clearFieldError('err_plateNumber');
  }

  // 入力時にハイフン等を除去
  document.querySelector('input[name="plateNumber"]').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  });

  // 送信時バリデーション
  document.getElementById('bookingForm').addEventListener('submit', (e) => {
    clearAllErrors();
    const plate = document.querySelector('input[name="plateNumber"]').value;
    if (!plate) {
      e.preventDefault();
      setFieldError('err_plateNumber', 'ナンバープレート下4桁を入力してください');
      setSummaryError('ナンバープレートが未入力です。');
      return;
    }
    if (!/^\\d{4}$/.test(plate)) {
      e.preventDefault();
      setFieldError('err_plateNumber', '4桁の数字で入力してください（1〜3桁の場合は0埋め）');
      setSummaryError('ナンバープレートは4桁の数字で入力してください。');
      return;
    }
    // 二重送信防止: バリデーション通過後は送信ボタンを無効化（LIFF/モバイルの連打対策）
    const submitBtn = document.querySelector('#bookingForm button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '送信中…'; submitBtn.classList.add('opacity-60'); }
  });
</script>`;

  return new Response(htmlLayout('確認', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
});

// ─── POST /booking/submit 予約申請作成 ─────────────────────────

booking.post('/booking/submit', async (c) => {
  try {
    const formData = await c.req.formData();
    const token = formData.get('token')?.toString();
    const date = formData.get('date')?.toString();
    const start = formData.get('start')?.toString();
    const end = formData.get('end')?.toString();
    const plateNumber = formData.get('plateNumber')?.toString();

    if (!token || !date || !start || !end || !plateNumber) {
      return renderError('入力内容に不備があります');
    }
    if (!/^\d{4}$/.test(plateNumber)) {
      return renderError('ナンバープレートは4桁の数字で入力してください');
    }
    // 3日前締切の最終ガード（サーバ側の権威判定）。ピッカー/画面を迂回した
    // 直近日の POST 偽装もここで確実に弾く。スロット確保・DB更新の前に判定する。
    if (date < getMinBookingDate()) return renderTooSoon();

    const record = await getBookingRequestByToken(c.env.DB, token);
    if (!record) return renderError('予約リンクが見つかりません');

    const session = c.get('bookingUser');
    if (!session) return renderAuthRequired(token, c);

    if (record.status !== 'pending_invite') {
      // 二重送信・「戻る」での再到達。申請は既に成立しているので、エラーや中間ページではなく
      // 完了画面（予約完了）を見せる。LINE アプリ内ブラウザが POST を二重送信しても、
      // どちらのリクエストも /booking/complete に着地するため必ず完了画面になる。
      // 承認済みは「確認をお待ちください」文言が不適切なので受付済みページにする。
      if (record.status === 'pending') return c.redirect(`/booking/complete?token=${encodeURIComponent(token)}`);
      if (record.status === 'approved') return renderAlreadyBooked(record.status);
      return renderError('この予約は受付できません', 'お手数ですが担当者へLINEでご連絡ください');
    }

    // スタッフ自動アサイン
    const slot = await pickStaffForSlot(
      c.env.DB,
      record.area,
      date,
      start,
      end,
      record.prefecture,
    );
    if (!slot) {
      return renderError(
        '申し訳ございません、ご希望の時間枠は他のお客様にご予約いただきました',
        '別の時間枠をお選びください',
      );
    }

    // スロットを先に原子的に確保する（二重予約対策）。ここで確保 → 予約書き込みの順にし、
    // 確保に失敗（同時予約に負けた）したら書き込まずにエラーを返す。
    const claimed = await markSlotBooked(c.env.DB, slot.id);
    if (!claimed) {
      return renderError(
        '申し訳ございません、ご希望の時間枠は他のお客様にご予約いただきました',
        '別の時間枠をお選びください',
      );
    }

    // booking_requests を更新
    await updateBookingRequest(c.env.DB, record.id, {
      staffId: slot.staff_id,
      slotId: slot.id,
      plateNumber,
      status: 'pending',
      friendId: record.friend_id || session.friendId,
    });

    // LINE通知（受付完了）— 非同期、失敗は無視
    try {
      await sendBookingReceivedNotification(c.env, record.id);
    } catch (err) {
      console.error('booking submit: LINE notification failed:', err);
    }

    // 完了画面へリダイレクト
    return c.redirect(`/booking/complete?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('POST /booking/submit error:', err);
    return renderError('予約申請に失敗しました', '時間をおいて再度お試しください');
  }
});

// ─── 「その他の県」3候補フロー ───────────────────────────────

booking.get('/booking/other', async (c) => {
  const token = c.req.query('token');
  if (!token) return renderError('リンクが不正です');

  const record = await getBookingRequestByToken(c.env.DB, token);
  if (!record) return renderError('予約リンクが見つかりません');
  if (record.area !== 'other') {
    return c.redirect(`/booking?token=${encodeURIComponent(token)}`);
  }
  if (record.status === 'approved' || record.status === 'pending') {
    return new Response(
      htmlLayout(
        '予約済み',
        `${renderHeader('予約済み')}
<main class="max-w-md mx-auto px-5 py-10">
  <div class="bg-white rounded-2xl p-6 shadow-sm">
    <div class="text-3xl mb-3">✅</div>
    <h1 class="text-base font-bold text-gray-900 mb-2">予約申請を受け付けています</h1>
    <p class="text-sm text-gray-600">現在のステータス: <span class="font-bold">${record.status === 'approved' ? '承認済み' : '確認中'}</span></p>
    <p class="text-xs text-gray-500 mt-3">変更はLINEで担当者にご連絡ください。</p>
  </div>
</main>`,
      ),
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' } },
    );
  }

  const session = c.get('bookingUser');
  if (!session) return renderAuthRequired(token, c);

  // 7日後〜90日後を選択可能にする（直近すぎる日程は対応不可）
  const MIN_DAYS_AHEAD = 7;
  const range = getDateRange(91); // index 0 = today
  const minDate = range[MIN_DAYS_AHEAD]; // 7日後
  const maxDate = range[90]; // 90日後

  const timeOptions = [
    { value: '10:00-12:00', label: '10:00〜12:00' },
    { value: '12:00-14:00', label: '12:00〜14:00' },
    { value: '14:00-16:00', label: '14:00〜16:00' },
    { value: '16:00-18:00', label: '16:00〜18:00（夏期のみ）' },
  ];

  const candidateBlock = (n: number) => `
<div class="bg-white rounded-2xl p-5 shadow-sm">
  <h3 class="text-sm font-bold text-gray-900 mb-3">第${n}候補</h3>
  <label class="block text-xs text-gray-500 mb-1">日付</label>
  <input type="date" name="candidate_${n}_date" min="${minDate}" max="${maxDate}"
    class="picker-input">
  <p id="err_candidate_${n}_date" class="hidden text-xs text-red-600 mt-2 font-bold"></p>
  <label class="block text-xs text-gray-500 mb-1 mt-3">時間帯</label>
  <select name="candidate_${n}_time" class="picker-input">
    <option value="">選択してください</option>
    ${timeOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
  </select>
  <p id="err_candidate_${n}_time" class="hidden text-xs text-red-600 mt-2 font-bold"></p>
</div>`;

  const body = `
${renderHeader('日程希望を3つ入力してください')}
<main class="max-w-md mx-auto px-5 py-5">
  <div class="bg-white rounded-2xl p-5 shadow-sm mb-4">
    <div class="text-xs text-gray-500">エリア</div>
    <div class="text-lg font-bold text-gray-900">その他の県</div>
    <div class="text-xs text-gray-500 mt-1">${escapeHtml(record.prefecture)}</div>
  </div>

  <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 text-xs text-blue-900">
    <p class="font-bold mb-1">📍 お住まいの地域について</p>
    <p class="leading-relaxed">撮影スタッフが定期巡回していないエリアのため、ご希望の日時を<strong>3つ</strong>ご入力ください。担当者が調整して日程を確定します。</p>
  </div>

  <div class="bg-yellow-50 border border-yellow-300 rounded-xl p-4 mb-4 text-xs text-yellow-900">
    <p class="font-bold mb-1">⚠️ 日程選択のご注意</p>
    <ul class="leading-relaxed list-disc list-inside space-y-1">
      <li>本日から<strong>7日以上先</strong>の日付を選択してください</li>
      <li>3つの候補は<strong>同じ日でも時間帯が異なれば</strong>OK（完全に同じ日時の重複は不可）</li>
      <li>調整可能な最短日: <strong>${minDate}</strong></li>
    </ul>
  </div>

  <form method="POST" action="/booking/other/submit" class="space-y-3" id="otherForm" novalidate>
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    ${candidateBlock(1)}
    ${candidateBlock(2)}
    ${candidateBlock(3)}

    <div class="bg-white rounded-2xl p-5 shadow-sm">
      <h2 class="text-sm font-bold text-gray-900 mb-2">🚗 ナンバープレート下4桁</h2>
      <p class="text-xs text-gray-500 mb-3">撮影当日の車両確認に使用します</p>
      <input
        type="text"
        name="plateNumber"
        inputmode="numeric"
        maxlength="4"
        placeholder="例: 0001"
        class="w-full px-4 py-3 text-2xl text-center font-bold tracking-widest border-2 border-gray-300 rounded-xl focus:border-brand focus:outline-none"
      >
      <p class="text-xs text-gray-500 mt-3 leading-relaxed">
        ※ 1〜3桁の場合は「<span class="font-bold">・</span>」の代わりに「<span class="font-bold text-brand">0</span>」を入力してください<br>
        <span class="text-gray-400">例: ・・・1 → <span class="font-bold text-gray-700">0001</span>　・・12 → <span class="font-bold text-gray-700">0012</span></span>
      </p>
      <p id="err_plateNumber" class="hidden text-xs text-red-600 mt-2 font-medium"></p>
    </div>

    <div id="formError" class="hidden bg-red-50 border-2 border-red-400 rounded-xl p-4 text-sm text-red-700 font-bold"></div>

    <button type="submit" class="w-full bg-brand text-white font-bold py-4 rounded-xl hover:opacity-90 transition-opacity">
      希望日程を申請する
    </button>
  </form>
</main>
<script>
  const MIN_DATE = ${JSON.stringify(minDate)};
  const formErrorEl = document.getElementById('formError');

  function setFieldError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '⚠️ ' + msg;
    el.classList.remove('hidden');
  }
  function clearFieldError(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
  }
  function clearAllErrors() {
    formErrorEl.classList.add('hidden');
    formErrorEl.textContent = '';
    for (let i = 1; i <= 3; i++) {
      clearFieldError('err_candidate_' + i + '_date');
      clearFieldError('err_candidate_' + i + '_time');
    }
    clearFieldError('err_plateNumber');
  }
  function setSummaryError(msg) {
    formErrorEl.textContent = '⚠️ ' + msg;
    formErrorEl.classList.remove('hidden');
  }

  document.querySelector('input[name="plateNumber"]').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  });

  // 日付・時間・ナンバーのフルバリデーション
  document.getElementById('otherForm').addEventListener('submit', (e) => {
    clearAllErrors();
    const slots = []; // 'YYYY-MM-DD|HH:MM-HH:MM' の組み合わせ重複チェック
    let firstError = null;
    let valid = true;

    for (let i = 1; i <= 3; i++) {
      const dEl = document.querySelector('input[name="candidate_' + i + '_date"]');
      const tEl = document.querySelector('select[name="candidate_' + i + '_time"]');
      const d = dEl.value;
      const t = tEl.value;

      let dateOk = true;
      if (!d) {
        setFieldError('err_candidate_' + i + '_date', '日付を選択してください');
        if (!firstError) firstError = '第' + i + '候補の日付が未入力です';
        valid = false;
        dateOk = false;
      } else if (d < MIN_DATE) {
        setFieldError('err_candidate_' + i + '_date',
          '本日から7日以上先（' + MIN_DATE + '以降）を選択してください');
        if (!firstError) firstError = '第' + i + '候補の日付が早すぎます（' + MIN_DATE + '以降を指定してください）';
        valid = false;
        dateOk = false;
      }

      if (!t) {
        setFieldError('err_candidate_' + i + '_time', '時間帯を選択してください');
        if (!firstError) firstError = '第' + i + '候補の時間帯が未選択です';
        valid = false;
      }

      // 日付＋時間帯の組み合わせ重複チェック
      if (dateOk && t) {
        const key = d + '|' + t;
        if (slots.includes(key)) {
          setFieldError('err_candidate_' + i + '_time',
            '他の候補と同じ日付・時間帯の組み合わせです。日付か時間帯を変更してください');
          if (!firstError) firstError = '第' + i + '候補が他の候補と完全に同じ日時です';
          valid = false;
        } else {
          slots.push(key);
        }
      }
    }

    const plateEl = document.querySelector('input[name="plateNumber"]');
    if (!/^\\d{4}$/.test(plateEl.value)) {
      setFieldError('err_plateNumber', '4桁の数字で入力してください（1〜3桁の場合は0埋め）');
      if (!firstError) firstError = 'ナンバープレートは4桁の数字で入力してください';
      valid = false;
    }

    if (!valid) {
      e.preventDefault();
      setSummaryError(firstError + '。各項目をご確認ください。');
    } else {
      // 二重送信防止: バリデーション通過後は送信ボタンを無効化（LIFF/モバイルの連打対策）
      const submitBtn = document.querySelector('#otherForm button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '送信中…'; submitBtn.classList.add('opacity-60'); }
    }
  });
</script>`;

  return new Response(htmlLayout('日程希望入力', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
});

booking.post('/booking/other/submit', async (c) => {
  try {
    const formData = await c.req.formData();
    const token = formData.get('token')?.toString();
    const plateNumber = formData.get('plateNumber')?.toString();
    if (!token) return renderError('パラメータが不足しています');
    if (!plateNumber || !/^\d{4}$/.test(plateNumber)) {
      return renderError('ナンバープレートは4桁の数字で入力してください');
    }

    const record = await getBookingRequestByToken(c.env.DB, token);
    if (!record) return renderError('予約リンクが見つかりません');
    if (record.area !== 'other') return renderError('このフォームは対象外の地域用です');

    const session = c.get('bookingUser');
    if (!session) return renderAuthRequired(token, c);

    if (record.status !== 'pending_invite') {
      // 二重送信・「戻る」での再到達。申請は既に成立しているので、エラーや中間ページではなく
      // 完了画面（予約完了）を見せる。LINE アプリ内ブラウザが POST を二重送信しても、
      // どちらのリクエストも /booking/complete に着地するため必ず完了画面になる。
      // 承認済みは「確認をお待ちください」文言が不適切なので受付済みページにする。
      if (record.status === 'pending') return c.redirect(`/booking/complete?token=${encodeURIComponent(token)}`);
      if (record.status === 'approved') return renderAlreadyBooked(record.status);
      return renderError('この予約は受付できません', 'お手数ですが担当者へLINEでご連絡ください');
    }

    // 7日後を最低日付として算出（JST基準）
    const MIN_DAYS_AHEAD = 7;
    const minDate = getDateRange(MIN_DAYS_AHEAD + 1)[MIN_DAYS_AHEAD];

    // 3候補をパース + バリデーション
    const candidates: Array<{ date: string; start: string; end: string }> = [];
    const seenSlots = new Set<string>();
    for (let i = 1; i <= 3; i++) {
      const date = formData.get(`candidate_${i}_date`)?.toString();
      const time = formData.get(`candidate_${i}_time`)?.toString();
      if (!date || !time || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(time)) {
        return renderError(`第${i}候補の日付と時間帯を入力してください`);
      }
      if (!isValidDateString(date)) {
        return renderError(`第${i}候補の日付形式が不正です`);
      }
      if (date < minDate) {
        return renderError(
          `第${i}候補の日付が早すぎます`,
          `本日から7日以上先の日付（${minDate} 以降）を選択してください`,
        );
      }
      const slotKey = `${date}|${time}`;
      if (seenSlots.has(slotKey)) {
        return renderError(
          '同じ日付・時間帯の重複があります',
          `${date} ${time} が他の候補と完全に重複しています。日付か時間帯を変更してください`,
        );
      }
      seenSlots.add(slotKey);
      const [start, end] = time.split('-');
      candidates.push({ date, start, end });
    }

    // DB更新（candidate_*_date/start/end カラムは updateBookingRequest 経由では対応していないので生クエリ）
    await c.env.DB.prepare(
      `UPDATE booking_requests
       SET candidate_1_date = ?, candidate_1_start = ?, candidate_1_end = ?,
           candidate_2_date = ?, candidate_2_start = ?, candidate_2_end = ?,
           candidate_3_date = ?, candidate_3_start = ?, candidate_3_end = ?,
           plate_number = ?, status = 'pending',
           friend_id = COALESCE(friend_id, ?),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(
        candidates[0].date, candidates[0].start, candidates[0].end,
        candidates[1].date, candidates[1].start, candidates[1].end,
        candidates[2].date, candidates[2].start, candidates[2].end,
        plateNumber,
        session.friendId,
        record.id,
      )
      .run();

    // LINE通知（受付完了）
    try {
      await sendOtherReceivedNotification(c.env, record.id);
    } catch (err) {
      console.error('booking other submit: LINE notification failed:', err);
    }

    return c.redirect(`/booking/complete?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('POST /booking/other/submit error:', err);
    return renderError('予約申請に失敗しました', '時間をおいて再度お試しください');
  }
});

// ─── GET /booking/complete 完了画面 ────────────────────────────

booking.get('/booking/complete', async (c) => {
  const token = c.req.query('token');
  if (!token) return renderError('リンクが不正です');

  const record = await getBookingRequestByToken(c.env.DB, token);
  if (!record) return renderError('予約リンクが見つかりません');

  const slot = record.slot_id ? await getStaffAvailabilityById(c.env.DB, record.slot_id) : null;

  const dateLabel = slot ? formatJstDateLabel(slot.date) : '';

  const body = `
${renderHeader('予約申請を受け付けました')}
<main class="max-w-md mx-auto px-5 py-10">
  <div class="bg-white rounded-2xl p-8 shadow-sm text-center">
    <div class="text-5xl mb-4">✅</div>
    <h1 class="text-lg font-bold text-gray-900 mb-2">予約申請完了</h1>
    <p class="text-sm text-gray-600 mb-6">担当者の確認をお待ちください</p>

    ${
      slot
        ? `<div class="bg-gray-50 rounded-xl p-4 text-left text-sm">
      <div class="flex justify-between mb-2">
        <span class="text-gray-500">日付</span>
        <span class="font-bold text-gray-900">${escapeHtml(dateLabel)}</span>
      </div>
      <div class="flex justify-between mb-2">
        <span class="text-gray-500">時間</span>
        <span class="font-bold text-gray-900">${slot.start_time} 〜 ${slot.end_time}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-gray-500">ナンバー</span>
        <span class="font-bold text-gray-900">${escapeHtml(record.plate_number || '')}</span>
      </div>
    </div>`
        : ''
    }
    <p class="text-xs text-gray-500 mt-6">確定次第、LINEでお知らせいたします</p>
  </div>
</main>`;

  return new Response(htmlLayout('予約申請完了', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
  });
});

// ─── LINE通知ヘルパー ──────────────────────────────────────────

async function sendBookingReceivedNotification(
  env: Env['Bindings'],
  bookingId: string,
): Promise<void> {
  // 予約レコードを再取得（更新後）
  const { getBookingRequestById } = await import('@line-crm/db');
  const booking = await getBookingRequestById(env.DB, bookingId);
  if (!booking || !booking.friend_id) return;

  const friend = await getFriendById(env.DB, booking.friend_id);
  if (!friend?.line_user_id) return;

  const slot = booking.slot_id ? await getStaffAvailabilityById(env.DB, booking.slot_id) : null;
  if (!slot) return;

  const dateLabel = formatJstDateLabel(slot.date);

  const flex = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '✅ 予約申請を受け付けました', weight: 'bold', size: 'md', color: '#ffffff' },
      ],
      backgroundColor: '#0f172a',
      paddingAll: '20px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: '担当者の確認をお待ちください',
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '日付', size: 'xs', color: '#94a3b8', flex: 2 },
                { type: 'text', text: dateLabel, size: 'sm', color: '#1e293b', weight: 'bold', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '時間', size: 'xs', color: '#94a3b8', flex: 2 },
                { type: 'text', text: `${slot.start_time} 〜 ${slot.end_time}`, size: 'sm', color: '#1e293b', weight: 'bold', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: 'ナンバー', size: 'xs', color: '#94a3b8', flex: 2 },
                { type: 'text', text: booking.plate_number || '-', size: 'sm', color: '#1e293b', weight: 'bold', flex: 5 },
              ],
            },
          ],
        },
      ],
      paddingAll: '20px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '確定次第、こちらからご連絡いたします',
          size: 'xs',
          color: '#94a3b8',
          align: 'center',
          wrap: true,
        },
      ],
      paddingAll: '12px',
    },
  };

  // 未フォロー（友だち未追加/ブロック中）には届かない。送信失敗として記録してスキップ。
  if (!friend.is_following) {
    const { logFailedOutgoing } = await import('../services/message-log.boxiv.js');
    await logFailedOutgoing(env.DB, friend.id, 'flex', JSON.stringify(flex));
    return;
  }
  const { LineClient } = await import('@line-crm/line-sdk');
  const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  const sentLineId = firstSentMessageId(await client.pushMessage(friend.line_user_id, [
    {
      type: 'flex',
      altText: '予約申請を受け付けました',
      contents: flex,
    },
  ]));
  // BOXIV: messages_log に記録して個別チャット画面に表示
  await logOutgoingBookingMessage(env.DB, friend.id, flex, sentLineId);
}

// 「その他の県」申請受付通知
async function sendOtherReceivedNotification(
  env: Env['Bindings'],
  bookingId: string,
): Promise<void> {
  const { getBookingRequestById } = await import('@line-crm/db');
  const booking = await getBookingRequestById(env.DB, bookingId);
  if (!booking || !booking.friend_id) return;

  const friend = await getFriendById(env.DB, booking.friend_id);
  if (!friend?.line_user_id) return;

  const candidates: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = (booking as unknown as Record<string, string | null>)[`candidate_${i}_date`];
    const s = (booking as unknown as Record<string, string | null>)[`candidate_${i}_start`];
    const e = (booking as unknown as Record<string, string | null>)[`candidate_${i}_end`];
    if (d && s && e) candidates.push(`第${i}候補: ${d} ${s}〜${e}`);
  }

  const flex = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '✅ 希望日程を受け付けました', weight: 'bold', size: 'md', color: '#ffffff' },
      ],
      backgroundColor: '#0f172a',
      paddingAll: '20px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: 'お住まいの地域は担当者による日程調整が必要です。ご希望の候補から担当者が決定し、あらためてご連絡いたします。',
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
        { type: 'separator', margin: 'md' },
        ...candidates.map((c) => ({
          type: 'text' as const,
          text: c,
          size: 'sm' as const,
          color: '#1e293b',
          weight: 'bold' as const,
          margin: 'sm' as const,
        })),
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          contents: [
            { type: 'text', text: 'ナンバー', size: 'xs', color: '#94a3b8', flex: 2 },
            {
              type: 'text',
              text: booking.plate_number || '-',
              size: 'sm',
              color: '#1e293b',
              weight: 'bold',
              flex: 5,
            },
          ],
        },
      ],
      paddingAll: '20px',
    },
  };

  // 未フォロー（友だち未追加/ブロック中）には届かない。送信失敗として記録してスキップ。
  if (!friend.is_following) {
    const { logFailedOutgoing } = await import('../services/message-log.boxiv.js');
    await logFailedOutgoing(env.DB, friend.id, 'flex', JSON.stringify(flex));
    return;
  }
  const { LineClient } = await import('@line-crm/line-sdk');
  const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  const sentLineId = firstSentMessageId(await client.pushMessage(friend.line_user_id, [
    {
      type: 'flex',
      altText: '希望日程を受け付けました',
      contents: flex,
    },
  ]));
  // BOXIV: messages_log に記録して個別チャット画面に表示
  await logOutgoingBookingMessage(env.DB, friend.id, flex, sentLineId);
}

// BOXIV: shared helper — log a booking-related outgoing flex message to messages_log
// so the individual chat view shows it alongside user-sent messages.
async function logOutgoingBookingMessage(
  db: D1Database,
  friendId: string,
  flex: unknown,
  lineMessageId: string | null = null,
): Promise<void> {
  try {
    const { jstNow } = await import('@line-crm/db');
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, delivery_type, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, ?, 'push', ?)`,
      )
      .bind(crypto.randomUUID(), friendId, JSON.stringify(flex), lineMessageId, jstNow())
      .run();
  } catch (err) {
    console.error('logOutgoingBookingMessage failed (non-blocking):', err);
  }
}

export { booking };
