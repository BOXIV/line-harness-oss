-- 908_message_send_status.sql
-- messages_log に送信ステータス列を追加する。
--   NULL / 'sent' = 送信成功（既存行は NULL のまま＝成功扱い）
--   'failed'      = 送信失敗（未フォロー宛 / LINE API エラー等で実際には届いていない）
--
-- 背景: 連携完了（friends.user_id 付与）でも、ユーザーが OA を友だち追加していなければ
-- メッセージは届かない。LINE Messaging API は未追加/ブロック宛 push に HTTP 200 を返すため
-- 送信側で失敗を検知できないが、送信前の is_following ガードや LINE API エラー時に
-- ここへ 'failed' を記録し、個別チャット画面で「送信失敗」として可視化する。
ALTER TABLE messages_log ADD COLUMN status TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_log_status ON messages_log (status);
