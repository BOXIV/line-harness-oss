-- 911_message_quote.sql
-- BOXIV: 友だちがトーク画面で「引用」して返信した際に、引用元メッセージを
-- オペレーターチャット（ダッシュボード）で確認できるようにするための列。
--
-- LINE Messaging API の message イベントは、引用返信のとき次を含む:
--   message.id              … この受信メッセージの LINE メッセージID
--   message.quotedMessageId … 引用された元メッセージの LINE メッセージID（引用返信のときだけ）
--   message.quoteToken      … このメッセージを将来引用するためのトークン（本機能では未使用）
--
-- 引用元の復元は friend_id × line_message_id で messages_log を照合して行う。
--   line_message_id   = LINE プラットフォーム上のメッセージID（受信メッセージに付与。引用解決のキー）
--   quoted_message_id = この受信メッセージが引用した元メッセージの line_message_id（非引用時は NULL）
--
-- 既存行（本機能より前の受信メッセージ）には line_message_id が無いため引用解決できないが、
-- メディア(画像/動画/音声/ファイル)は R2 key に messageId を含むため API 側でキーから救済復元する。
ALTER TABLE messages_log ADD COLUMN line_message_id TEXT;
ALTER TABLE messages_log ADD COLUMN quoted_message_id TEXT;

-- 引用解決の照合用（friend スコープ + line_message_id）。
CREATE INDEX IF NOT EXISTS idx_messages_log_line_message_id
  ON messages_log (friend_id, line_message_id);
