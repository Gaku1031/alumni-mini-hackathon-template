-- 支払先はイベントごとに持つ。幹事が違えば送金先も違うので、サーバー単位だと
-- 並行して走る2つの募集がお互いの送金先を上書きしてしまう。
alter table bento_events add column payment_info text;

-- guild_settings に入っていた送金先URLを、そのサーバーの既存イベントへ移す。
-- 締め切りモーダルの初期値は「同じサーバーで最後に使った支払先」を引くので、
-- これで次回の入力は今までどおり省略できる。
update bento_events
   set payment_info = (select paypay_url from guild_settings s where s.guild_id = bento_events.guild_id)
 where payment_info is null;

-- 支払先がイベント側に移ったので、この1列だけのテーブルは要らなくなった
drop table guild_settings;
