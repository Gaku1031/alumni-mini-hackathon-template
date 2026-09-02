/**
 * 共通費用（配送料・API代など）の均等割と、各自の支払額の算出。
 * 描画も DB アクセスもしない純粋な計算なので、単体でテストできる。
 */

/** bento_events.shared_costs に JSON で入っている1行 */
export type SharedCost = { label: string; amount: number };

/**
 * 「ラベル 金額」の行を金額として読む。末尾の数字を金額、その手前をラベルにする。
 * `¥` と `円`、桁区切りのカンマは付いていても外す。
 */
const LINE = /^(.*?)\s*¥?(-?\d[\d,]*)\s*円?$/;

/**
 * 締め切りの Modal に入った共通費用を読む。1行に1件。
 *
 * 金額として読めない行は黙って捨てる。1行打ち間違えただけで入力全体が
 * 弾かれると、Modal を開き直すところからやり直しになるため。
 * 逆にラベルの無い（金額だけの）行は捨てない。集める金額が消えるほうが困る。
 */
export function parseSharedCosts(input: string): SharedCost[] {
  const costs: SharedCost[] = [];
  for (const line of input.split("\n")) {
    // Discord は日本語入力のまま送られてくる。全角数字と全角空白を先に寄せる
    const match = LINE.exec(line.normalize("NFKC").trim());
    if (!match) continue;
    const amount = Number(match[2].replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    costs.push({ label: match[1] || "共通費用", amount });
  }
  return costs;
}

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
