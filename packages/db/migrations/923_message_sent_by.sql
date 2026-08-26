-- 923_message_sent_by.sql
-- BOXIV: 送信メッセージに「誰が送ったか」を記録する。
--
-- オペレーターチャットで、送信バブルの日時の左に送信者名を出すために要る。
-- 顧客側（LINE トーク）には一切出さない。あくまで管理画面の表示用。
--
-- sent_by_name を非正規化して持つ理由: スタッフの改名・退職（行削除）後も、
-- 「当時だれが送ったか」の記録は変わってはいけない。id だけだと過去の表示が壊れる。
-- FK は張らない（スタッフ削除で NULL に倒されると記録が消える）。
-- ALTER TABLE では CHECK/FK を付けられず、schema.sql 側にだけ書くと
-- 「新規作成した DB」と「migration を積んだ DB」でスキーマが食い違う（promote-d1 の履歴乖離）。
--
-- NULL のままになるのは自動送信（シナリオ配信 / 一斉配信 / 自動応答 / automation）。
-- 管理画面では名前を出さない＝「人が打ったものではない」と読める。
ALTER TABLE messages_log ADD COLUMN sent_by_id TEXT;
ALTER TABLE messages_log ADD COLUMN sent_by_name TEXT;
