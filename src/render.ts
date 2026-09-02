/**
 * 集計メッセージの組み立て。製品のすべてがこの1枚に収まっている。
 * DB も Discord API も触らない純関数なので、入力を並べれば出力が全部決まる。
 */

import type { BentoEvent, Order } from "./db";
import type { MessageBody } from "./discord";

/** components の type */
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;

/** button の style */
const PRIMARY = 1;
const SECONDARY = 2;

/** セレクトの選択肢は Discord 側の上限が25件 */
const MAX_OPTIONS = 25;

/** 弁当代は3桁区切り。ICU に頼らず自前で入れる */
const yen = (amount: number) => `¥${String(amount).replace(/\B(?=(\d{3})+$)/g, ",")}`;

/** [頼む ▼] の value。`select_order` 側で price と item_name に割り戻す */
export const itemValue = (itemName: string, price: number) => `${price}:${itemName}`;

/** 同じ品・同じ値段の注文をまとめた1行 */
export type ItemLine = { itemName: string; price: number; names: string[] };

export function groupOrders(orders: Order[]): ItemLine[] {
  const lines = new Map<string, ItemLine>();
  for (const order of orders) {
    const key = itemValue(order.item_name, order.price);
    const line = lines.get(key) ?? { itemName: order.item_name, price: order.price, names: [] };
    line.names.push(order.display_name);
    lines.set(key, line);
  }
  return [...lines.values()];
}

/** 注文フェーズの1枚。まだ誰も頼んでいない状態もここで描く */
export function renderOpen(
  event: Pick<BentoEvent, "title" | "menu_url">,
  orders: Order[],
): MessageBody {
  const lines = groupOrders(orders);

  const text = [`📌 ${event.title}`];
  if (event.menu_url) text.push(`📎 メニュー: ${event.menu_url}`);
  text.push("");

  if (lines.length === 0) {
    text.push("まだ注文がありません");
  } else {
    for (const line of lines) {
      text.push(
        `🍱 ${line.itemName}  ${yen(line.price)}  ×${line.names.length}  ${line.names.join(", ")}`,
      );
    }
    text.push("────────────────");
    text.push(`弁当代 ${yen(orders.reduce((sum, order) => sum + order.price, 0))}`);
  }

  return { content: text.join("\n"), components: openComponents(lines, orders) };
}

/** セレクトは1つで1行を占める。ボタンだけ横に並べられる */
const row = (...components: MessageBody[]): MessageBody => ({ type: ACTION_ROW, components });

function openComponents(lines: ItemLine[], orders: Order[]): MessageBody[] {
  const rows: MessageBody[] = [];

  // 既出の品が無いうちは [頼む ▼] を出さない。選択肢0件のセレクトは Discord が受け付けない
  if (lines.length > 0) {
    rows.push(
      row({
        type: STRING_SELECT,
        custom_id: "select_order",
        placeholder: "頼む",
        options: lines.slice(0, MAX_OPTIONS).map((line) => ({
          label: `${line.itemName} ${yen(line.price)}`,
          value: itemValue(line.itemName, line.price),
        })),
      }),
    );
  }

  // 誰のでも取り消せる。打ち間違いを直す手段を兼ねている
  if (orders.length > 0) {
    rows.push(
      row({
        type: STRING_SELECT,
        custom_id: "cancel_order",
        placeholder: "取り消す",
        options: orders.slice(0, MAX_OPTIONS).map((order) => ({
          label: `${order.display_name} / ${order.item_name} ${yen(order.price)}`,
          value: order.id,
        })),
      }),
    );
  }

  rows.push(
    row(
      { type: BUTTON, style: PRIMARY, custom_id: "new_item", label: "新しく入力" },
      { type: BUTTON, style: SECONDARY, custom_id: "close_event", label: "締め切る" },
    ),
  );

  return rows;
}
