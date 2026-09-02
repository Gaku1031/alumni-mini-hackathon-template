/**
 * 集計メッセージ（Embed とボタン行）の組み立て。
 * これがこの製品のすべてなので、状態が変わるたびにこの結果で元メッセージを差し替える。
 * DB も Discord API も触らない純関数なので、単体でテストできる。
 *
 * 注文フェーズが renderOpen、締め切ったあとの集金フェーズが renderClosed。
 * ボタンから開く Modal の中身（newItemModal）も、同じ理由でここに置く。
 */

import type { MessageBody } from "./discord";
import type { SharedCost, Split } from "./split";

/** bento_orders の1行のうち、描画に要る分だけ */
export type Order = {
  id: string;
  display_name: string;
  item_name: string;
  price: number;
};

/** bento_events のうち、描画に要る分だけ */
export type BentoEvent = {
  title: string;
  menu_url?: string | null;
};

/** 同じ品（item_name + price）に集まった注文 */
export type ItemGroup = {
  item_name: string;
  price: number;
  orders: Order[];
};

/** Discord のコンポーネント type */
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const TEXT_INPUT = 4;

/** テキスト欄の style。1行が SHORT */
const SHORT = 1;

/** ボタンの style */
const PRIMARY = 1;
const SUCCESS = 3;
const DANGER = 4;

/** セレクトの選択肢は25件まで。超えると Discord に弾かれてメッセージごと出なくなる */
const MAX_OPTIONS = 25;

/** label と value は100文字まで */
const LIMIT = 100;

const yen = (amount: number) => `¥${amount.toLocaleString("en-US")}`;

const cut = (text: string) => (text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text);

/** [頼む ▼] の value。price を先に置くと最初の ":" で割るだけで戻せる */
const itemKey = (item: { item_name: string; price: number }) => `${item.price}:${item.item_name}`;

/** 同じ品を1行にまとめる。並びは最初に注文された順 */
export function groupByItem(orders: Order[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const order of orders) {
    const key = itemKey(order);
    const group: ItemGroup = groups.get(key) ?? {
      item_name: order.item_name,
      price: order.price,
      orders: [],
    };
    group.orders.push(order);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function row(...components: MessageBody[]): MessageBody {
  return { type: ACTION_ROW, components };
}

function itemLine(group: ItemGroup): string {
  const names = group.orders.map((order) => order.display_name).join(", ");
  return `🍱 ${group.item_name}  ${yen(group.price)}  ×${group.orders.length}  ${names}`;
}

export function renderOpen(event: BentoEvent, orders: Order[]): MessageBody {
  const groups = groupByItem(orders);
  const total = orders.reduce((sum, order) => sum + order.price, 0);

  const description = [
    ...(event.menu_url ? [`📎 メニュー: ${event.menu_url}`, ""] : []),
    ...(groups.length > 0 ? groups.map(itemLine) : ["まだ注文はありません"]),
    "",
    `弁当代 ${yen(total)}`,
  ].join("\n");

  const rows: MessageBody[] = [];
  // 既出の品が無いうちは選択肢が作れない。[新しく入力] だけで始めてもらう
  if (groups.length > 0) {
    rows.push(
      row({
        type: STRING_SELECT,
        custom_id: "order_select",
        placeholder: "頼む",
        options: groups.slice(0, MAX_OPTIONS).map((group) => ({
          label: cut(`${group.item_name} ${yen(group.price)}`),
          value: cut(itemKey(group)),
        })),
      }),
    );
  }
  if (orders.length > 0) {
    rows.push(
      row({
        type: STRING_SELECT,
        custom_id: "cancel_select",
        placeholder: "取り消す",
        options: orders.slice(0, MAX_OPTIONS).map((order) => ({
          label: cut(`${order.display_name} / ${order.item_name} ${yen(order.price)}`),
          value: order.id,
        })),
      }),
    );
  }
  rows.push(
    row(
      { type: BUTTON, custom_id: "new_item", style: PRIMARY, label: "新しく入力" },
      { type: BUTTON, custom_id: "close", style: DANGER, label: "締め切る" },
    ),
  );

  return {
    embeds: [{ title: `📌 ${event.title}`, description }],
    components: rows,
  };
}

/**
 * `[新しく入力]` で開く Modal の中身。品名と金額の2欄だけ。
 *
 * 送信された Modal には「どのメッセージから開いたか」が付いてこないので、
 * custom_id に元メッセージの id を載せて持ち回る。イベントはそこから引く。
 */
export function newItemModal(messageId: string): MessageBody {
  return {
    custom_id: `new_item:${messageId}`,
    title: "注文を入力",
    components: [
      row({
        type: TEXT_INPUT,
        custom_id: "item_name",
        label: "品名",
        style: SHORT,
        placeholder: "唐揚げ弁当",
        max_length: LIMIT,
        required: true,
      }),
      // 金額は検算しない。桁を間違えても集計メッセージに大きく出るので人間が気づく
      row({
        type: TEXT_INPUT,
        custom_id: "price",
        label: "金額（円）",
        style: SHORT,
        placeholder: "650",
        required: true,
      }),
    ],
  };
}

/** 集金フェーズで要る分。paid は SQLite なので 0/1 */
export type ClosedOrder = Order & { paid: 0 | 1 };

/** 締め切り済みイベント。shared_costs は [締め切る] の Modal で焼き込まれている */
export type ClosedEvent = BentoEvent & { shared_costs: SharedCost[] };

const names = (orders: { display_name: string }[]) =>
  orders.map((order) => order.display_name).join(", ");

/**
 * 弁当代・割前・送る金額の3つを並べる。暗算させないのがこの製品の要件なので、
 * 足し算の式ごと出して、実際に送る金額だけを太字にする。
 */
function paymentLine(group: ItemGroup, perPerson: number): string {
  const amount = `${yen(group.price)} + ${yen(perPerson)} = **${yen(group.price + perPerson)}**`;
  return `🍱 ${group.item_name}  ${amount}  ×${group.orders.length}  ${names(group.orders)}`;
}

/**
 * 集金フェーズの集計メッセージ。
 *
 * 金額は splitShared の結果をそのまま受け取る。ここで割り算をやり直さないので、
 * 表示と計算がずれない（このファイルは値の import を持たない描画専用のまま）。
 *
 * 未払い者は名前で並べるが、@メンションは絶対に入れない。
 * 通知が飛ぶと催促になって角が立つ。「見れば分かるが、鳴らない」が設計上の強度。
 */
export function renderClosed(
  event: ClosedEvent,
  split: Split<ClosedOrder>,
  paypayUrl?: string | null,
): MessageBody {
  const { perPerson, surplus, payments: orders } = split;
  const groups = groupByItem(orders);
  const bento = orders.reduce((sum, order) => sum + order.price, 0);
  const shared = event.shared_costs.reduce((sum, cost) => sum + cost.amount, 0);
  const paid = orders.filter((order) => order.paid);
  const unpaid = orders.filter((order) => !order.paid);

  // 「弁当代 ¥3,730 ＋ 配送料 ¥500 = ¥4,230」。共通費用はラベルごとに出す
  const totals = [
    `弁当代 ${yen(bento)}`,
    ...event.shared_costs.map((cost) => `${cost.label} ${yen(cost.amount)}`),
  ].join(" ＋ ");

  // 共通費用が1行だけならそのラベルで呼ぶ（「配送料は6人で均等割」）
  const label = event.shared_costs.length === 1 ? event.shared_costs[0].label : "共通費用";
  const rounding = surplus > 0 ? `（端数切り上げ・余り${yen(surplus)}は幹事）` : "";
  const splitNote = `${label}は${orders.length}人で均等割 → ${yen(perPerson)}${rounding}`;

  // 未払いが誰も居ない状態を「0人」ではなく言葉で出す。ここが幹事の見たい一行
  let progress = `💰 集金 ${paid.length}/${orders.length}`;
  if (unpaid.length > 0) progress += `      未払い: ${names(unpaid)}`;
  else if (orders.length > 0) progress += "      全員支払い済み";

  const lines = groups.map((group) => paymentLine(group, perPerson));
  const description = [
    ...(lines.length > 0 ? lines : ["注文はありません"]),
    "",
    shared > 0 ? `${totals} = ${yen(bento + shared)}` : totals,
    ...(shared > 0 && orders.length > 0 ? [splitNote] : []),
    "",
    progress,
    ...(paypayUrl ? [`送金先 → ${paypayUrl}`] : []),
  ].join("\n");

  const rows: MessageBody[] = [
    row({ type: BUTTON, custom_id: "paid", style: SUCCESS, label: "支払った" }),
  ];
  // 誰も払っていないうちは戻す相手がいない。選択肢が空のセレクトは Discord に弾かれる
  if (paid.length > 0) {
    rows.push(
      row({
        type: STRING_SELECT,
        custom_id: "unpaid_select",
        placeholder: "未払いに戻す",
        options: paid.slice(0, MAX_OPTIONS).map((order) => ({
          label: cut(`${order.display_name} / ${order.item_name} ${yen(order.price + perPerson)}`),
          value: order.id,
        })),
      }),
    );
  }

  return {
    embeds: [{ title: `📌 ${event.title}`, description }],
    components: rows,
  };
}
