/**
 * 共通費用の均等割の自己チェック。
 *
 *   node --test test/split.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Node が .ts を直接 import できるようになるのは v22.18 から。
// ビルド手順を足したくないので、型だけ落として読み込む。
const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/split.ts", import.meta.url), "utf8"),
);
const { splitShared } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const orders = (...prices) => prices.map((price, i) => ({ name: `p${i}`, price }));
const six = () => orders(600, 750, 480, 900, 620, 700);

test("配送料500を6人で割ると1人あたり84（切り上げ）", () => {
  const { perPerson } = splitShared([{ label: "配送料", amount: 500 }], six());
  assert.equal(perPerson, 84);
});

test("切り上げた分が余りとして返る", () => {
  const { surplus } = splitShared([{ label: "配送料", amount: 500 }], six());
  assert.equal(surplus, 84 * 6 - 500);
});

test("共通費用が複数行のときは合計に対して均等割される", () => {
  const { perPerson, surplus } = splitShared(
    [
      { label: "配送料", amount: 500 },
      { label: "API代", amount: 300 },
    ],
    six(),
  );
  assert.equal(perPerson, 134);
  assert.equal(surplus, 134 * 6 - 800);
});

test("共通費用が無いときは割前0で、支払額は弁当代と一致する", () => {
  const { perPerson, surplus, payments } = splitShared([], orders(600, 750, 480));
  assert.equal(perPerson, 0);
  assert.equal(surplus, 0);
  assert.deepEqual(
    payments.map((p) => p.total),
    [600, 750, 480],
  );
});

test("注文0件でもゼロ除算にならない", () => {
  const { perPerson, surplus, payments } = splitShared([{ label: "配送料", amount: 500 }], []);
  assert.equal(perPerson, 0);
  assert.equal(surplus, 0);
  assert.deepEqual(payments, []);
});

test("各自の支払額は 弁当代 + 割前", () => {
  const { perPerson, payments } = splitShared([{ label: "配送料", amount: 500 }], six());
  assert.equal(perPerson, 84);
  assert.deepEqual(
    payments.map((p) => p.total),
    [684, 834, 564, 984, 704, 784],
  );
  // 元の注文の情報は落とさない
  assert.equal(payments[0].name, "p0");
});
