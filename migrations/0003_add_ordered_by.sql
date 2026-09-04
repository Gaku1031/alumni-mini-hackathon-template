-- 代理入力。行は「頼む本人」のものとして入れる（discord_user_id は本人）ので、
-- 締め切り後の「支払った」は本人が押せる。unique(event_id, discord_user_id) も
-- そのまま生きるから、本人があとから自分で入れ直せば上書きになる。
-- この列に入るのは代わりに入力した人の表示名。null は本人が自分で入れた分。
alter table bento_orders add column ordered_by text;
