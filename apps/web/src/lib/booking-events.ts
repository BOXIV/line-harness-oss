/**
 * 予約の承認待ち件数バッジ用の更新通知。
 *
 * 予約一覧で承認/却下/キャンセル/削除したら即座にサイドバーのバッジへ反映させる
 * （ポーリングを待たずに消えるように）。
 */
export const BOOKINGS_CHANGED_EVENT = 'lh:bookings-changed'

export function notifyBookingsChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(BOOKINGS_CHANGED_EVENT))
}
