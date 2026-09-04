-- 締め切りを知らせる @here のメッセージ。再開したときに、この1本を書き換えて
-- 「締め切りました」を残さないようにする。持っていないと後から探しようがない
alter table bento_events add column notice_message_id text;
