/**
 * 注文フェーズの集計メッセージ（Embed とボタン行）の組み立て。
 * これがこの製品のすべてなので、注文が増えるたびにこの結果で元メッセージを差し替える。
 * DB も Discord API も触らない純関数なので、単体でテストできる。
 */

import type { MessageBody } from "./discord";

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

/** ボタンの style */
const PRIMARY = 1;
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
