/**
 * 共通費用（配送料・API代など）の均等割と、各自の支払額の算出。
 * 描画も DB アクセスもしない純粋な計算なので、単体でテストできる。
 */

/** bento_events.shared_costs に JSON で入っている1行 */
export type SharedCost = { label: string; amount: number };

export type Split<T> = {
  /** 1人あたりの共通費用。切り捨てると幹事が持ち出しになるので切り上げる */
  perPerson: number;
  /** 切り上げで集まりすぎた分。perPerson × 人数 − 共通費用の合計 */
  surplus: number;
  /** 元の注文に、弁当代＋割前を total として足したもの */
  payments: (T & { total: number })[];
};

export function splitShared<T extends { price: number }>(
  sharedCosts: SharedCost[],
  orders: T[],
): Split<T> {
  const total = sharedCosts.reduce((sum, cost) => sum + cost.amount, 0);
  // 注文0件のときは割る相手がいない。共通費用は誰にも乗らないので余りも0
  const perPerson = orders.length === 0 ? 0 : Math.ceil(total / orders.length);
  return {
    perPerson,
    surplus: perPerson * orders.length - (orders.length === 0 ? 0 : total),
    payments: orders.map((order) => ({ ...order, total: order.price + perPerson })),
  };
}
