/**
 * D1 に触るのはこのファイルだけ。SQL を先頭にまとめてあるので、
 * 「値が全部 ? になっているか」はこの一覧を見るだけで確かめられる。
 * 文字列で値を埋め込んだクエリは1本も足さないこと。
 *
 * SQLite なので boolean と JSON は無い。paid は 0/1 のまま返し
 * （JS では `if (order.paid)` がそのまま効く）、shared_costs だけ
 * 文字列で持っているものを読むときに配列へ戻す。
 */

const INSERT_EVENT = `insert into bento_events (id, guild_id, channel_id, title, menu_url)
values (?, ?, ?, ?, ?)`;

const SELECT_EVENT = `select * from bento_events where id = ?`;

// ボタンが押されたときに分かるのは押されたメッセージだけ。そこからイベントを引く
const SELECT_EVENT_BY_MESSAGE = `select * from bento_events where message_id = ?`;

const UPDATE_EVENT_MESSAGE = `update bento_events set message_id = ? where id = ?`;

const CLOSE_EVENT = `update bento_events set status = 'closed', shared_costs = ? where id = ?`;

// created_at は datetime('now') の秒精度。同じ秒に入った注文の順は決まらないので、
// 挿入順そのものである rowid で必ずタイブレークする（id はランダムな UUID なので使えない）
const SELECT_ORDERS = `select * from bento_orders where event_id = ? order by created_at, rowid`;

// 1人1個は unique 制約で担保されている。2回目は例外ではなく changes = 0 になる
const INSERT_ORDER = `insert into bento_orders
(id, event_id, discord_user_id, display_name, item_name, price)
values (?, ?, ?, ?, ?, ?)
on conflict (event_id, discord_user_id) do nothing`;

const DELETE_ORDER = `delete from bento_orders where id = ?`;

const UPDATE_PAID = `update bento_orders set paid = ? where id = ?`;

// メニュー用のテーブルは無い。注文そのものが `[頼む ▼]` の選択肢になる
const SELECT_ITEMS = `select distinct item_name, price from bento_orders
where event_id = ? order by price, item_name`;

const SELECT_PAYPAY_URL = `select paypay_url from guild_settings where guild_id = ?`;

const UPSERT_PAYPAY_URL = `insert into guild_settings (guild_id, paypay_url) values (?, ?)
on conflict (guild_id) do update set paypay_url = excluded.paypay_url`;

/** 締め切り時に入力する、みんなで割る費用 */
export type SharedCost = { label: string; amount: number };

export type BentoEvent = {
  id: string;
  guild_id: string;
  channel_id: string;
  /** 集計メッセージ。投稿してから setMessageId で入る */
  message_id: string | null;
  title: string;
  menu_url: string | null;
  status: "open" | "closed";
  shared_costs: SharedCost[];
  created_at: string;
};

/** DB の中の姿。shared_costs は JSON 文字列のまま */
type EventRow = Omit<BentoEvent, "shared_costs"> & { shared_costs: string };

export type Order = {
  id: string;
  event_id: string;
  discord_user_id: string;
  display_name: string;
  item_name: string;
  price: number;
  /** SQLite に boolean は無い。0/1 */
  paid: 0 | 1;
  created_at: string;
};

/** 既出の品 */
export type MenuItem = { item_name: string; price: number };

/** 2回目の注文は duplicate。呼び出し側はこれを見て「すでに頼んでいます」と返す */
export type AddOrderResult = { ok: true; id: string } | { ok: false; reason: "duplicate" };

export async function createEvent(
  db: D1Database,
  input: { guildId: string; channelId: string; title: string; menuUrl?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const { guildId, channelId, title, menuUrl } = input;
  await db
    .prepare(INSERT_EVENT)
    .bind(id, guildId, channelId, title, menuUrl ?? null)
    .run();
  return id;
}

export async function getEvent(db: D1Database, eventId: string): Promise<BentoEvent | null> {
  return toEvent(await db.prepare(SELECT_EVENT).bind(eventId).first<EventRow>());
}

/** 集計メッセージ上のボタン・セレクト・Modal から、対象のイベントに戻る */
export async function getEventByMessage(
  db: D1Database,
  messageId: string,
): Promise<BentoEvent | null> {
  return toEvent(await db.prepare(SELECT_EVENT_BY_MESSAGE).bind(messageId).first<EventRow>());
}

function toEvent(row: EventRow | null): BentoEvent | null {
  if (!row) return null;
  return { ...row, shared_costs: JSON.parse(row.shared_costs) };
}

/** 集計メッセージを投稿したあとに、その message_id を書き戻す */
export async function setMessageId(db: D1Database, eventId: string, id: string): Promise<void> {
  await db.prepare(UPDATE_EVENT_MESSAGE).bind(id, eventId).run();
}

/** `[締め切る]` の Modal で入った共通費用を焼き込んで集金フェーズへ移す */
export async function closeEvent(
  db: D1Database,
  eventId: string,
  sharedCosts: SharedCost[],
): Promise<void> {
  await db.prepare(CLOSE_EVENT).bind(JSON.stringify(sharedCosts), eventId).run();
}

/** 集計メッセージを描くたびに呼ぶ。注文順なので表示の並びが毎回同じになる */
export async function listOrders(db: D1Database, eventId: string): Promise<Order[]> {
  const { results } = await db.prepare(SELECT_ORDERS).bind(eventId).all<Order>();
  return results;
}

export async function addOrder(
  db: D1Database,
  input: {
    eventId: string;
    discordUserId: string;
    displayName: string;
    itemName: string;
    price: number;
  },
): Promise<AddOrderResult> {
  const id = crypto.randomUUID();
  const { eventId, discordUserId, displayName, itemName, price } = input;
  const statement = db.prepare(INSERT_ORDER);
  try {
    const { meta } = await statement
      .bind(id, eventId, discordUserId, displayName, itemName, price)
      .run();
    return meta.changes > 0 ? { ok: true, id } : { ok: false, reason: "duplicate" };
  } catch (error) {
    // do nothing で 0 件になるはずだが、unique 違反を例外で投げてくる場合もある。
    // 呼び出し側は「すでに頼んでいます」と返せれば良いので、ここで止める
    if (isUniqueViolation(error)) return { ok: false, reason: "duplicate" };
    throw error;
  }
}

/** 1人1個の unique 制約に当たったか。D1 は "D1_ERROR: UNIQUE constraint failed: ..." で来る */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

/** 消せたら true。取り消しは誰でも押せるので、既に消えていることがある */
export async function deleteOrder(db: D1Database, orderId: string): Promise<boolean> {
  const { meta } = await db.prepare(DELETE_ORDER).bind(orderId).run();
  return meta.changes > 0;
}

export async function setPaid(db: D1Database, orderId: string, paid: boolean): Promise<void> {
  await db
    .prepare(UPDATE_PAID)
    .bind(paid ? 1 : 0, orderId)
    .run();
}

export async function distinctItems(db: D1Database, eventId: string): Promise<MenuItem[]> {
  const { results } = await db.prepare(SELECT_ITEMS).bind(eventId).all<MenuItem>();
  return results;
}

export async function getPaypayUrl(db: D1Database, guildId: string): Promise<string | null> {
  const url = await db.prepare(SELECT_PAYPAY_URL).bind(guildId).first<string>("paypay_url");
  return url ?? null;
}

export async function setPaypayUrl(db: D1Database, guildId: string, url: string): Promise<void> {
  await db.prepare(UPSERT_PAYPAY_URL).bind(guildId, url).run();
}
