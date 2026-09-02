-- 弁当イベント。1チャンネルに1枚の集計メッセージが対応する
create table bento_events (
  id           text primary key,
  guild_id     text not null,
  channel_id   text not null,
  message_id   text,                     -- 集計メッセージ。edit の対象
  title        text not null,
  menu_url     text,
  status       text not null default 'open' check (status in ('open', 'closed')),
  shared_costs text not null default '[]',  -- JSON: [{"label":"配送料","amount":500}]
  created_at   text not null default (datetime('now'))
);

create table bento_orders (
  id              text primary key,
  event_id        text not null references bento_events(id) on delete cascade,
  discord_user_id text not null,
  display_name    text not null,
  item_name       text not null,
  price           integer not null,
  paid            integer not null default 0,  -- SQLite に boolean は無い。0/1
  created_at      text not null default (datetime('now')),
  unique (event_id, discord_user_id)           -- 1人1個を構造で担保
);

-- 集計メッセージを描くたびに event_id で全件引くので必須
create index idx_bento_orders_event on bento_orders (event_id);

create table guild_settings (
  guild_id   text primary key,
  paypay_url text
);
