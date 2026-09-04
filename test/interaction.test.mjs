/**
 * Discord に人を集めなくても動作を確かめられるようにするためのテスト。
 * Discord がやることは「Ed25519 で署名した JSON を POST する」だけなので、
 * 同じ形の JSON を自分で署名して wrangler dev に投げれば全部再現できる。
 *
 *   npm test
 *
 * ローカルの D1 を毎回まっさらにしてから使う（本番の DB は触らない）。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

/** 空きポートを OS に選ばせる。決め打つと他のツールとぶつかる */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let URL_;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");

/** Discord と同じ形で署名する: sign(timestamp + body) */
function signed(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
}

/** 署名して投げ、返ってきた interaction response を返す */
async function send(interaction) {
  const body = JSON.stringify(interaction);
  const res = await fetch(URL_, { method: "POST", headers: signed(body), body });
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  return res.json();
}

function sql(command) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "bento-enam", "--local", "--command", command],
    {
      stdio: "ignore",
    },
  );
}

// ── Discord が送ってくる interaction の組み立て ────────────────────────

const G = "guild-1";

/** ボタン。type 2 のコンポーネントを押した形 */
function button(eventId, action, { user = "u1", name = "たろう" } = {}) {
  return send({
    type: 3,
    guild_id: G,
    channel_id: "chan-1",
    data: { custom_id: `${action}:${eventId}`, component_type: 2 },
    member: { user: { id: user, username: name } },
  });
}

/** セレクトメニュー。選んだ値が data.values に入る */
function select(eventId, action, value, { user = "u1", name = "たろう" } = {}) {
  return send({
    type: 3,
    guild_id: G,
    channel_id: "chan-1",
    data: { custom_id: `${action}:${eventId}`, component_type: 3, values: [value] },
    member: { user: { id: user, username: name } },
  });
}

/** モーダル送信。入力欄は1行1コンポーネントで入れ子になって届く */
function submit(eventId, action, fields, { user = "u1", name = "たろう" } = {}) {
  return send({
    type: 5,
    guild_id: G,
    channel_id: "chan-1",
    data: {
      custom_id: `${action}:${eventId}`,
      components: Object.entries(fields).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
    member: { user: { id: user, username: name } },
  });
}

/** 代理入力（ユーザーセレクトで相手を選ぶ → モーダル送信）。相手の表示名は resolved で届く */
function pickUser(eventId, targetId, targetName, who = {}) {
  const { user = "u1", name = "たろう" } = who;
  return send({
    type: 3,
    guild_id: G,
    channel_id: "chan-1",
    data: {
      custom_id: `proxy:${eventId}`,
      component_type: 5,
      values: [targetId],
      resolved: { users: { [targetId]: { id: targetId, username: targetName } } },
    },
    member: { user: { id: user, username: name } },
  });
}

/** 注文を1件入れる（「新しく入力」→ モーダル送信 の実際の流れ） */
function order(eventId, itemName, price, who) {
  return submit(eventId, "newitem", { item_name: itemName, price: String(price) }, who);
}

/**
 * 集計メッセージを読むだけの操作が無いので、何も消さない取り消しを投げて
 * 再描画だけさせる。0件削除 → そのまま再描画、という経路自体のテストも兼ねる。
 */
async function board(eventId, closed = false) {
  const res = closed
    ? await select(eventId, "unpay", "no-such-order")
    : await select(eventId, "cancel", "no-such-order");
  assert.equal(res.type, 7, `盤面を読めなかった: ${JSON.stringify(res)}`);
  return res.data;
}

/** 集計メッセージの「×N」を足した数 = 生きている注文の件数 */
function counted(content) {
  return [...content.matchAll(/×(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
}

/** custom_id の頭が action のコンポーネントを1つ返す */
function comp(components, action) {
  return components
    .flatMap((row) => row.components)
    .find((c) => c.custom_id.startsWith(`${action}:`));
}

/** ボタン・セレクトの custom_id を全部平らに並べる */
function ids(components) {
  return components.flatMap((row) => row.components.map((c) => c.custom_id.split(":")[0]));
}

// ── 起動 ──────────────────────────────────────────────────────────

let dev;
/** テスト用の鍵で .dev.vars を上書きするので、本物は退避して必ず戻す */
let savedDevVars = null;
let seq = 0;
/** 各テストは自分専用のイベントを使う。並行テストが互いを壊さないように */
const nextEvent = () => `ev-${seq++}`;

before(async () => {
  if (existsSync(".dev.vars")) savedDevVars = readFileSync(".dev.vars");
  writeFileSync(".dev.vars", `DISCORD_PUBLIC_KEY=${publicKeyHex}\nDISCORD_BOT_TOKEN=dummy\n`);

  // ローカルの D1 にテーブルが無いとハンドラが落ちる。冪等なので毎回打つ
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "bento-enam", "--local"], {
    stdio: "ignore",
  });

  // イベントは wrangler 越しの SQL が遅いので、必要な数をまとめて1回で作る。
  // `/bento` 本体は Discord へメッセージを投稿するので、そこはここでは通さない
  const stmts = ["delete from bento_orders", "delete from bento_events"];
  for (let i = 0; i < 80; i++) {
    stmts.push(
      `insert into bento_events (id, guild_id, channel_id, title, created_at)
       values ('ev-${i}', '${G}', 'chan-1', '9/15(月) お弁当', '2026-02-0${(i % 9) + 1}')`,
    );
  }
  // /bento の引数でメニューを入れて作られた状態
  stmts.push(
    `insert into bento_events (id, guild_id, channel_id, title, menu_url, created_at)
     values ('with-menu', '${G}', 'chan-1', '9/15(月) お弁当', 'https://example.com/menu', '2026-02-01')`,
  );
  // 支払先の初期値テスト用。同じサーバーの「前回」に値が入っている状態を作る
  stmts.push(
    `insert into bento_events (id, guild_id, channel_id, title, payment_info, created_at)
       values ('old-paid', 'guild-prefill', 'chan-1', '先週のお弁当', 'PayPay 090-0000-0000', '2026-01-01')`,
    `insert into bento_events (id, guild_id, channel_id, title, created_at)
       values ('today-prefill', 'guild-prefill', 'chan-1', '今日のお弁当', '2026-01-02')`,
    // 履歴がまったく無いサーバー
    `insert into bento_events (id, guild_id, channel_id, title, created_at)
       values ('first-ever', 'guild-empty', 'chan-1', 'はじめてのお弁当', '2026-01-02')`,
  );
  sql(stmts.join(";\n"));

  const port = await freePort();
  URL_ = `http://127.0.0.1:${port}`;
  dev = spawn("npx", ["wrangler", "dev", "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    // ここで待つのは「起動したか」だけ。応答の中身は各テストで見る
    try {
      await fetch(URL_);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("wrangler dev が起動しなかった");
});

after(() => {
  dev?.kill();
  if (savedDevVars !== null) writeFileSync(".dev.vars", savedDevVars);
});

// ── 署名 ──────────────────────────────────────────────────────────

describe("署名検証", () => {
  test("正しい署名の PING に PONG を返す", async () => {
    assert.deepEqual(await send({ type: 1 }), { type: 1 });
  });

  test("署名が壊れていたら 401", async () => {
    const body = JSON.stringify({ type: 1 });
    const headers = signed(body);
    headers["x-signature-ed25519"] = "00".repeat(64);
    const res = await fetch(URL_, { method: "POST", headers, body });
    assert.equal(res.status, 401);
  });

  test("署名ヘッダが無ければ 401", async () => {
    const body = JSON.stringify({ type: 1 });
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 401);
  });

  // 公開エンドポイントなので、Discord 以外からゴミも飛んでくる。
  // Ed25519 は64バイト固定で、長さが違うと verify は false ではなく例外を投げる
  for (const [name, sig] of [
    ["短すぎる", "00"],
    ["長すぎる", "00".repeat(65)],
    ["16進ですらない", "zz".repeat(64)],
    ["空", ""],
  ]) {
    test(`署名が壊れていても 500 にせず 401（${name}）`, async () => {
      const body = JSON.stringify({ type: 1 });
      const headers = signed(body);
      headers["x-signature-ed25519"] = sig;
      const res = await fetch(URL_, { method: "POST", headers, body });
      assert.equal(res.status, 401);
    });
  }

  test("ボディを差し替えたら 401（署名対象は生ボディ）", async () => {
    const headers = signed(JSON.stringify({ type: 1 }));
    const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ type: 2 }) });
    assert.equal(res.status, 401);
  });
});

// ── 注文 ──────────────────────────────────────────────────────────

describe("注文を入れる", () => {
  test("「新しく入力」で品名と金額のモーダルが返る", async () => {
    const res = await button(nextEvent(), "new");
    assert.equal(res.type, 9);
    assert.deepEqual(
      res.data.components.flatMap((r) => r.components.map((c) => c.custom_id)),
      ["item_name", "price"],
    );
  });

  test("モーダルを送ると集計メッセージに載る", async () => {
    const ev = nextEvent();
    const res = await order(ev, "唐揚げ弁当", 650);
    assert.equal(res.type, 7);
    assert.match(res.data.content, /- 唐揚げ弁当\s+¥650\s+×1\s+たろう/);
  });

  test("メニューのURLを入れておくと集計メッセージから開ける", async () => {
    const { content } = await board("with-menu");
    assert.match(content, /メニュー: https:\/\/example\.com\/menu/);
  });

  test("注文が0件のときはその旨を出す", async () => {
    const { content } = await board(nextEvent());
    assert.match(content, /まだ注文がありません/);
    assert.match(content, /弁当代 ¥0/);
  });

  test("品名が空なら弾いて本人にだけ返す", async () => {
    const ev = nextEvent();
    const res = await order(ev, "   ", 650);
    assert.equal(res.type, 4);
    assert.equal(res.data.flags, 64);
    assert.equal(counted((await board(ev)).content), 0);
  });

  test("金額が数字でなければ弾く", async () => {
    const ev = nextEvent();
    const res = await order(ev, "唐揚げ弁当", "いくらだっけ");
    assert.equal(res.type, 4);
    assert.equal(counted((await board(ev)).content), 0);
  });

  test("全角数字やカンマ・円つきでも金額として読む", async () => {
    const ev = nextEvent();
    const res = await order(ev, "うな重", "１,２００円");
    assert.match(res.data.content, /- うな重\s+¥1,200/);
  });

  test("同じ人が入れ直すと上書きされる（1人1個）", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    const res = await order(ev, "焼肉弁当", 800);
    assert.equal(counted(res.data.content), 1);
    assert.match(res.data.content, /焼肉弁当/);
    assert.doesNotMatch(res.data.content, /唐揚げ弁当/);
  });

  test("別の人が同じ品を頼むと1行にまとまる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    const res = await order(ev, "唐揚げ弁当", 650, { user: "u2", name: "はなこ" });
    assert.match(res.data.content, /- 唐揚げ弁当\s+¥650\s+×2\s+たろう, はなこ/);
    assert.match(res.data.content, /弁当代 ¥1,300/);
  });

  test("同じ品名でも金額が違えば別の行になる", async () => {
    const ev = nextEvent();
    await order(ev, "日替わり", 600, { user: "u1" });
    const res = await order(ev, "日替わり", 700, { user: "u2", name: "はなこ" });
    assert.match(res.data.content, /日替わり\s+¥600\s+×1/);
    assert.match(res.data.content, /日替わり\s+¥700\s+×1/);
  });

  test("既に出ている品は「頼む」から選べる", async () => {
    const ev = nextEvent();
    const first = await order(ev, "唐揚げ弁当", 650);
    const pick = first.data.components.flatMap((r) => r.components).find((c) => c.type === 3);
    assert.equal(pick.placeholder, "頼む");
    assert.deepEqual(pick.options, [{ label: "唐揚げ弁当 ¥650", value: "650:唐揚げ弁当" }]);

    const res = await select(ev, "pick", pick.options[0].value, { user: "u2", name: "はなこ" });
    assert.match(res.data.content, /唐揚げ弁当\s+¥650\s+×2/);
  });

  test("品名にコロンが入っていても金額と品名が壊れない", async () => {
    const ev = nextEvent();
    const first = await order(ev, "本日のランチ:から揚げ", 700);
    const pick = first.data.components.flatMap((r) => r.components).find((c) => c.type === 3);
    const res = await select(ev, "pick", pick.options[0].value, { user: "u2", name: "はなこ" });
    assert.match(res.data.content, /本日のランチ:から揚げ\s+¥700\s+×2/);
  });

  test("表示名は nick > global_name > username の順に使う", async () => {
    const ev = nextEvent();
    const res = await send({
      type: 5,
      guild_id: G,
      channel_id: "chan-1",
      data: {
        custom_id: `newitem:${ev}`,
        components: [
          { type: 1, components: [{ type: 4, custom_id: "item_name", value: "そば" }] },
          { type: 1, components: [{ type: 4, custom_id: "price", value: "500" }] },
        ],
      },
      member: {
        nick: "たろちゃん",
        user: { id: "u9", global_name: "Taro", username: "taro_1234" },
      },
    });
    assert.match(res.data.content, /たろちゃん/);
  });

  test("取り消すと消える", async () => {
    const ev = nextEvent();
    const first = await order(ev, "唐揚げ弁当", 650);
    const cancel = first.data.components
      .flatMap((r) => r.components)
      .find((c) => c.custom_id.startsWith("cancel:"));
    const res = await select(ev, "cancel", cancel.options[0].value);
    assert.equal(counted(res.data.content), 0);
    assert.match(res.data.content, /まだ注文がありません/);
  });

  test("消えたイベントのボタンを押しても落ちない", async () => {
    const res = await button("no-such-event", "pay");
    assert.equal(res.type, 4);
    assert.match(res.data.content, /もうありません/);
  });
});

// ── 締め切りと支払先 ──────────────────────────────────────────────

describe("代理で入れる", () => {
  /** 相手を選ぶ → 戻ってきたモーダルをそのまま送る、という実際の流れ */
  async function orderFor(eventId, target, targetName, itemName, price, who) {
    const modal = await pickUser(eventId, target, targetName, who);
    assert.equal(modal.type, 9);
    const forName = modal.data.components[0].components[0].value;
    return submit(
      `${eventId}:${target}`,
      "newitem",
      { for_name: forName, item_name: itemName, price: String(price) },
      who,
    );
  }

  // 既出の品は選べたほうが速い。モーダルにセレクトは入れられないので、
  // 相手を選んだあとに本人だけに見えるメニューを出す
  test("既出の品があるときは、相手を選ぶとメニューが出る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);

    const res = await pickUser(ev, "u9", "じろう");
    assert.equal(res.type, 4);
    assert.equal(res.data.flags, 64);
    assert.match(res.data.content, /じろう/);
    const [menu, manual] = res.data.components.map((r) => r.components[0]);
    assert.equal(menu.custom_id, `ppick:${ev}:u9:じろう`);
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ["650:唐揚げ弁当"],
    );
    assert.equal(manual.custom_id, `pnew:${ev}:u9:じろう`);
  });

  test("メニューから選べば、そのまま相手の注文になる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });

    const res = await select(`${ev}:u9:じろう`, "ppick", "650:唐揚げ弁当", {
      user: "u1",
      name: "たろう",
    });
    // 押したのは ephemeral の上なので、返事は ephemeral の差し替えになる。
    // 集計メッセージのほうは bot が別に書き換える
    assert.equal(res.type, 7);
    assert.match(res.data.content, /じろう の分を入れました/);
    assert.deepEqual(res.data.components, []);

    const after = await board(ev);
    assert.equal(counted(after.content), 2);
    assert.match(after.content, /じろう（たろうが代理入力）/);
  });

  test("メニューに無いものは、そこからモーダルで入れられる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });

    const modal = await button(`${ev}:u9:じろう`, "pnew", { user: "u1", name: "たろう" });
    assert.equal(modal.type, 9);
    assert.equal(modal.data.custom_id, `pitem:${ev}:u9`);
    assert.equal(modal.data.components[0].components[0].value, "じろう");

    const res = await submit(
      `${ev}:u9`,
      "pitem",
      { for_name: "じろう", item_name: "そば", price: "500" },
      { user: "u1", name: "たろう" },
    );
    assert.equal(res.type, 7);
    assert.match(res.data.content, /じろう の分を入れました/);

    const after = await board(ev);
    assert.match(after.content, /そば.*じろう（たろうが代理入力）/);
  });

  test("相手を選ぶと「誰の分」が埋まったモーダルが返る", async () => {
    const res = await pickUser(nextEvent(), "u9", "じろう");
    assert.equal(res.type, 9);
    assert.deepEqual(
      res.data.components.flatMap((r) => r.components.map((c) => c.custom_id)),
      ["for_name", "item_name", "price"],
    );
    assert.equal(res.data.components[0].components[0].value, "じろう");
  });

  test("代理で入れた分は本人の名前で載り、入れた人もわかる", async () => {
    const ev = nextEvent();
    const res = await orderFor(ev, "u9", "じろう", "唐揚げ弁当", 650, {
      user: "u1",
      name: "たろう",
    });
    assert.match(res.data.content, /- 唐揚げ弁当\s+¥650\s+×1\s+じろう（たろうが代理入力）/);
  });

  test("代理で入れた分は本人が「支払った」を押せる", async () => {
    const ev = nextEvent();
    await orderFor(ev, "u9", "じろう", "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await submit(ev, "doclose", { shared: "", payment: "" });
    const res = await button(ev, "pay", { user: "u9", name: "じろう" });
    assert.match(res.data.content, /\*\*集金\*\* 1\/1/);
  });

  test("本人があとから自分で入れ直すと1件のままで、代理の跡も消える", async () => {
    const ev = nextEvent();
    await orderFor(ev, "u9", "じろう", "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    const res = await order(ev, "そば", 500, { user: "u9", name: "じろう" });
    assert.equal(counted(res.data.content), 1);
    assert.match(res.data.content, /- そば\s+¥500\s+×1\s+じろう$/m);
  });

  test("自分を選んで入れても代理扱いにはしない", async () => {
    const ev = nextEvent();
    const res = await orderFor(ev, "u1", "たろう", "そば", 500, { user: "u1", name: "たろう" });
    assert.doesNotMatch(res.data.content, /代理入力/);
  });
});

describe("メニューのリンク", () => {
  // /bento の任意引数は Discord の UI に埋もれる。ボタン側から辿れることが本題
  test("未設定なら『メニューを貼る』、設定済みなら『メニューを変える』", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    assert.equal(comp((await board(ev)).components, "menu").label, "メニューを貼る");

    await submit(ev, "domenu", { menu_url: "https://example.com/menu.pdf" });
    assert.equal(comp((await board(ev)).components, "menu").label, "メニューを変える");
  });

  test("ボタンから貼ると集計に出る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "domenu", { menu_url: "https://example.com/menu.pdf" });
    assert.match((await board(ev)).content, /メニュー: https:\/\/example\.com\/menu\.pdf/);
  });

  test("モーダルには今の値が入っている", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "domenu", { menu_url: "https://example.com/a.pdf" });
    const modal = await button(ev, "menu");
    assert.equal(modal.type, 9);
    assert.equal(modal.data.components[0].components[0].value, "https://example.com/a.pdf");
  });

  test("https:// を省いても補われる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "domenu", { menu_url: "example.com/menu" });
    assert.match((await board(ev)).content, /https:\/\/example\.com\/menu/);
  });

  test("空で送ると消える", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "domenu", { menu_url: "https://example.com/menu.pdf" });
    await submit(ev, "domenu", { menu_url: "  " });
    assert.doesNotMatch((await board(ev)).content, /メニュー/);
    assert.equal(comp((await board(ev)).components, "menu").label, "メニューを貼る");
  });

  test("締め切ったあとは貼れない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "doclose", { shared: "", payment: "" });
    const res = await button(ev, "menu");
    assert.equal(res.type, 4);
    assert.match(res.data.content, /締め切られています/);
    assert.equal(comp((await board(ev, true)).components, "menu"), undefined);
  });
});

describe("締め切る", () => {
  test("締め切りモーダルに割り勘と支払先の欄が出る", async () => {
    const res = await button(nextEvent(), "close");
    assert.equal(res.type, 9);
    const fields = res.data.components.flatMap((r) => r.components);
    assert.deepEqual(
      fields.map((c) => c.custom_id),
      ["shared", "payment"],
    );
    const payment = fields[1];
    assert.equal(payment.required, false);
    // 何を書けばいいか placeholder で分かること
    assert.match(payment.placeholder, /PayPay/);
    assert.match(payment.placeholder, /090-/);
    assert.match(payment.placeholder, /https:\/\//);
    assert.match(payment.placeholder, /銀行/);
  });

  // 送金先は電話番号や口座なので、同じサーバーの他のイベントへ引き継がない。
  // 引き継ぐと、用の済んだ番号がサーバー単位でいつまでも残る
  test("他のイベントの支払先を初期値にしない", async () => {
    const res = await button("today-prefill", "close");
    const payment = res.data.components.flatMap((r) => r.components)[1];
    assert.equal(payment.value, undefined);
  });

  test("再開して締め直すときは、そのイベントの値が初期値に入る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800);
    await submit(ev, "doclose", { shared: "", payment: "PayPay 090-1111-2222" });
    await button(ev, "reopen");
    const res = await button(ev, "close");
    const payment = res.data.components.flatMap((r) => r.components)[1];
    assert.equal(payment.value, "PayPay 090-1111-2222");
  });

  test("支払先は自由文字列で、複数行のまま表示する", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    const res = await submit(ev, "doclose", {
      shared: "",
      payment: "〇〇銀行 △△支店\n普通 1234567\nヤマダタロウ",
    });
    assert.match(res.data.content, /\*\*支払先\*\*\n〇〇銀行 △△支店\n普通 1234567\nヤマダタロウ/);
  });

  test("支払先を空で締め切れば支払先の行は出ない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    const res = await submit(ev, "doclose", { shared: "", payment: "" });
    assert.doesNotMatch(res.data.content, /支払先/);
  });

  test("割り勘は人数で割って端数を切り上げる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await order(ev, "焼肉弁当", 800, { user: "u2", name: "はなこ" });
    await order(ev, "そば", 500, { user: "u3", name: "じろう" });
    const res = await submit(ev, "doclose", { shared: "配送料 500", payment: "PayPay 090-1" });
    // 500 / 3 = 166.66… → 167
    assert.match(res.data.content, /均等割 → ¥167（端数切り上げ）/);
    assert.match(res.data.content, /唐揚げ弁当\s+¥650 \+ ¥167 = \*\*¥817\*\*/);
    assert.match(res.data.content, /弁当代 ¥1,950　＋　配送料 ¥500　=　¥2,450/);
  });

  test("割り勘の行は全角スペースや全角数字でも読む", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    const res = await submit(ev, "doclose", { shared: "配送料　５００\n氷代 1,000", payment: "" });
    assert.match(res.data.content, /配送料 ¥500/);
    assert.match(res.data.content, /氷代 ¥1,000/);
    assert.match(res.data.content, /=　¥2,150/);
  });

  test("割り勘が空なら弁当代だけを出す", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    const res = await submit(ev, "doclose", { shared: "  \n  ", payment: "" });
    assert.match(res.data.content, /弁当代 ¥650/);
    assert.doesNotMatch(res.data.content, /均等割/);
  });

  test("誰も頼んでいなくても締め切れる（0除算しない）", async () => {
    const ev = nextEvent();
    const res = await submit(ev, "doclose", { shared: "配送料 500", payment: "" });
    assert.equal(res.type, 7);
    assert.match(res.data.content, /\*\*集金\*\* 0\/0/);
  });

  test("締め切ると集金のボタンに切り替わる", async () => {
    const ev = nextEvent();
    // 締め切る u1 自身が頼むと自動で払い済みになり「取り消す」まで出る。
    // ここで見たいのは切り替わりだけなので、頼むのは別の人にする
    await order(ev, "唐揚げ弁当", 650, { user: "u2", name: "じろう" });
    const res = await submit(ev, "doclose", { shared: "", payment: "" });
    assert.deepEqual(ids(res.data.components), ["pay", "reopen"]);
  });

  test("締め切った人の分は最初から払い済みになる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await order(ev, "のり弁", 400, { user: "u2", name: "じろう" });
    const res = await submit(ev, "doclose", { shared: "", payment: "" });
    assert.match(res.data.content, /\*\*集金\*\* 1\/2/);
    assert.match(res.data.content, /未払い: じろう/);
    assert.doesNotMatch(res.data.content, /未払い:.*たろう/);
  });

  test("弁当を頼んでいない人が締め切っても誰も払い済みにならない", async () => {
    const ev = nextEvent();
    await order(ev, "のり弁", 400, { user: "u2", name: "じろう" });
    // 配送料の頭数は注文者だけ。頼まない幹事は分母に入らない
    const res = await submit(ev, "doclose", { shared: "配送料 500", payment: "" }, { user: "u1" });
    assert.match(res.data.content, /\*\*集金\*\* 0\/1/);
    assert.match(res.data.content, /配送料は1人で均等割 → ¥500/);
  });

  test("立て替えた人が集金の行に出る", async () => {
    const ev = nextEvent();
    await order(ev, "のり弁", 400, { user: "u2", name: "じろう" });
    const res = await submit(ev, "doclose", { shared: "", payment: "" }, { name: "たろう" });
    assert.match(res.data.content, /\*\*集金\*\* 0\/1（立て替え: たろう）/);
  });

  test("空振りした締め切りでは押した人が払い済みにならない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await order(ev, "のり弁", 400, { user: "u2", name: "じろう" });
    await submit(ev, "doclose", { shared: "", payment: "" }, { user: "u2", name: "じろう" });
    // すでに締め切られたあとに u1 が古い盤面から締め切りを送っても、勝手に払い済みにしない
    await submit(ev, "doclose", { shared: "", payment: "" }, { user: "u1", name: "たろう" });
    const content = (await board(ev, true)).content;
    assert.match(content, /\*\*集金\*\* 1\/2/);
    assert.match(content, /未払い: たろう/);
  });

  test("締め切り済みに注文は入れられない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1" });
    await submit(ev, "doclose", { shared: "", payment: "" });

    for (const res of [
      await button(ev, "new", { user: "u2" }),
      await submit(ev, "newitem", { item_name: "そば", price: "500" }, { user: "u2" }),
      await select(ev, "pick", "650:唐揚げ弁当", { user: "u2" }),
      await select(ev, "cancel", "whatever", { user: "u2" }),
    ]) {
      assert.equal(res.type, 4, JSON.stringify(res));
      assert.match(res.data.content, /締め切られています/);
    }
    assert.equal(counted((await board(ev, true)).content), 1);
  });

  test("二重に締め切っても最初の内容が残る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    await submit(ev, "doclose", { shared: "配送料 500", payment: "PayPay 090-1111-1111" });

    // 古い画面の「締め切る」を押した場合と、開いたままのモーダルを送った場合
    const again = await button(ev, "close");
    assert.match(again.data.content, /締め切られています/);
    const resubmit = await submit(ev, "doclose", { shared: "配送料 9999", payment: "別の口座" });
    assert.equal(resubmit.type, 4);
    assert.match(resubmit.data.content, /締め切られています/);

    const { content } = await board(ev, true);
    assert.match(content, /配送料 ¥500/);
    assert.match(content, /PayPay 090-1111-1111/);
  });

  test("締め切る前に集金は触れない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    for (const res of [await button(ev, "pay"), await button(ev, "reopen")]) {
      assert.equal(res.type, 4);
      assert.match(res.data.content, /まだ開いています/);
    }
  });
});

// ── 集金 ──────────────────────────────────────────────────────────

describe("集金する", () => {
  test("「支払った」で自分の分だけが払い済みになる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await order(ev, "焼肉弁当", 800, { user: "u2", name: "はなこ" });
    await submit(ev, "doclose", { shared: "", payment: "" });

    const res = await button(ev, "pay", { user: "u1", name: "たろう" });
    assert.match(res.data.content, /\*\*集金\*\* 1\/2/);
    assert.match(res.data.content, /未払い: はなこ/);
  });

  test("全員が払うと未払いの行が消える", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await order(ev, "そば", 500, { user: "u2", name: "はなこ" });
    await submit(ev, "doclose", { shared: "", payment: "" });
    await button(ev, "pay", { user: "u1" });
    const res = await button(ev, "pay", { user: "u2", name: "はなこ" });
    assert.match(res.data.content, /\*\*集金\*\* 2\/2/);
    assert.doesNotMatch(res.data.content, /未払い:/);
  });

  test("頼んでいない人が「支払った」を押したら本人に知らせる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1" });
    await submit(ev, "doclose", { shared: "", payment: "" });
    const res = await button(ev, "pay", { user: "no-order", name: "通りすがり" });
    assert.equal(res.type, 4);
    assert.match(res.data.content, /注文が見つかりません/);
  });

  test("二重に「支払った」を押しても数は増えない", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1" });
    await submit(ev, "doclose", { shared: "", payment: "" });
    await button(ev, "pay", { user: "u1" });
    const res = await button(ev, "pay", { user: "u1" });
    assert.match(res.data.content, /\*\*集金\*\* 1\/1/);
  });

  test("間違えて押した人を未払いに戻せる", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1", name: "たろう" });
    await submit(ev, "doclose", { shared: "", payment: "" });
    const paid = await button(ev, "pay", { user: "u1", name: "たろう" });
    const unpay = paid.data.components
      .flatMap((r) => r.components)
      .find((c) => c.custom_id.startsWith("unpay:"));
    assert.equal(unpay.options[0].label, "たろう / 唐揚げ弁当");

    const res = await select(ev, "unpay", unpay.options[0].value);
    assert.match(res.data.content, /\*\*集金\*\* 0\/1/);
  });

  test("再開すると注文のボタンに戻り、注文も残っている", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1" });
    await submit(ev, "doclose", { shared: "配送料 500", payment: "PayPay 090-1" });
    const res = await button(ev, "reopen");
    assert.deepEqual(ids(res.data.components), ["pick", "cancel", "proxy", "new", "menu", "close"]);
    assert.equal(counted(res.data.content), 1);
    // 開いている間は割り勘も支払先も出さない
    assert.doesNotMatch(res.data.content, /均等割/);
    assert.doesNotMatch(res.data.content, /支払先/);

    // 開き直したので、また注文できる
    const added = await order(ev, "そば", 500, { user: "u2", name: "はなこ" });
    assert.equal(counted(added.data.content), 2);
  });

  // 「@here 締め切りました」を残すと、あとから見た人が締め切られたと思う。
  // 再開したらその通知を書き換えにいくが、消されていれば Discord は 404 を返す。
  // 通知を直せなかっただけで再開そのものが落ちてはいけない
  test("締め切り通知を書き換えられなくても再開は通る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650);
    await submit(ev, "doclose", { shared: "", payment: "" });
    sql(`update bento_events set notice_message_id = 'no-such-message' where id = '${ev}'`);

    const res = await button(ev, "reopen");
    assert.equal(res.type, 7);
    assert.doesNotMatch(res.data.content, /集金/);
    // 書き換え先は使い切り。次に締め切ったときの通知で入れ直す
    assert.equal(counted(res.data.content), 1);
  });
});

// ── Discord 側の上限 ──────────────────────────────────────────────
//
// ここを破ると Discord が 400 を返し、押した人には「この操作に失敗しました」
// としか出ない。手で試して気づける類のものではないので機械で見張る。

describe("残さないもの", () => {
  test("全員が支払い終わっても支払先は残る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 800, { user: "p1", name: "いち" });
    await order(ev, "のり弁", 500, { user: "p2", name: "に" });
    await submit(ev, "doclose", { shared: "", payment: "PayPay 090-1111-2222" });

    await button(ev, "pay", { user: "p1" });
    const done = await button(ev, "pay", { user: "p2" });
    assert.match(done.data.content, /090-1111-2222/);

    // 押し間違いを戻したとき、送金先が読めないと払えない。
    // 全員払ったら消す、という作りにするとここが壊れる
    const back = await select(ev, "unpay", comp(done.data.components, "unpay").options[0].value);
    assert.match(back.data.content, /090-1111-2222/);
  });

  test("本文に @everyone と書かれてもメンションにしない", async () => {
    const ev = nextEvent();
    await order(ev, "@everyone 弁当", 800);
    const res = await select(ev, "cancel", "no-such-order");
    assert.deepEqual(res.data.allowed_mentions, { parse: [] });
    // 文字列自体はそのまま出す。消したり伏せ字にしたりはしない
    assert.match(res.data.content, /@everyone 弁当/);
  });
});

describe("Discord の制限に収まっている", () => {
  /** 返ってきた interaction response がそのまま Discord に通る形か */
  function fits(data) {
    if (data.content !== undefined) {
      assert.ok(data.content.length <= 2000, `content ${data.content.length} 文字`);
    }
    const rows = data.components ?? [];
    assert.ok(rows.length <= 5, `action row ${rows.length} 行`);
    for (const row of rows) {
      assert.ok(row.components.length <= 5);
      for (const c of row.components) {
        assert.ok(c.custom_id.length <= 100, `custom_id ${c.custom_id}`);
        if (c.label !== undefined) assert.ok([...c.label].length <= 80, `label ${c.label}`);
        if (c.placeholder !== undefined) {
          assert.ok([...c.placeholder].length <= 100, `placeholder ${c.placeholder}`);
        }
        if (c.options) {
          assert.ok(c.options.length <= 25, `選択肢 ${c.options.length} 件`);
          for (const o of c.options) {
            assert.ok([...o.label].length <= 100, `選択肢の label ${o.label}`);
            assert.ok([...o.value].length <= 100, `選択肢の value ${o.value}`);
          }
        }
      }
    }
  }

  test("30人が長い品名で頼んでも集計メッセージが2000文字を超えない", async () => {
    const ev = nextEvent();
    const long = "あ".repeat(60);
    for (let i = 0; i < 30; i++) {
      await order(ev, `${long}${i}`.slice(0, 60), 1000 + i, {
        user: `big${i}`,
        name: `なまえ${i}`,
      });
    }
    const open = await board(ev);
    fits(open);
    assert.match(open.content, /長くなりすぎたので省略/);

    const closed = await submit(ev, "doclose", {
      shared: "配送料 5000",
      payment: "〇".repeat(400),
    });
    fits(closed.data);
  });

  test("締め切りモーダルも入力欄の上限に収まる", async () => {
    const res = await button(nextEvent(), "close");
    for (const c of res.data.components.flatMap((r) => r.components)) {
      assert.ok([...c.label].length <= 45, `label ${c.label}`);
      assert.ok([...(c.placeholder ?? "")].length <= 100, `placeholder ${c.placeholder}`);
    }
    assert.ok([...res.data.title].length <= 45);
  });

  test("注文モーダルも入力欄の上限に収まる", async () => {
    const res = await button(nextEvent(), "new");
    for (const c of res.data.components.flatMap((r) => r.components)) {
      assert.ok([...c.label].length <= 45, `label ${c.label}`);
    }
  });
});

// ── 同時に押されたとき ────────────────────────────────────────────

describe("同時に押されたとき", () => {
  test("10人が一斉に注文しても全員分が残る", async () => {
    const ev = nextEvent();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        order(ev, `弁当${i}`, 500 + i, { user: `p${i}`, name: `ひと${i}` }),
      ),
    );
    assert.equal(counted((await board(ev)).content), 10);
  });

  test("同じものを一斉に頼んでも1行にまとまり、人数分だけ数える", async () => {
    const ev = nextEvent();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        order(ev, "唐揚げ弁当", 650, { user: `q${i}`, name: `ひと${i}` }),
      ),
    );
    const { content } = await board(ev);
    assert.match(content, /- 唐揚げ弁当\s+¥650\s+×5/);
    assert.equal(counted(content), 5);
    assert.match(content, /弁当代 ¥3,250/);
  });

  test("同じ人が一斉に3回入れても1件しか残らない", async () => {
    const ev = nextEvent();
    await Promise.all([
      order(ev, "唐揚げ弁当", 650, { user: "same" }),
      order(ev, "焼肉弁当", 800, { user: "same" }),
      order(ev, "そば", 500, { user: "same" }),
    ]);
    assert.equal(counted((await board(ev)).content), 1);
  });

  test("注文と締め切りが同時でも金額の内訳が食い違わない", async () => {
    const ev = nextEvent();
    await order(ev, "先に入れた弁当", 600, { user: "first", name: "さき" });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        order(ev, "唐揚げ弁当", 650, { user: `r${i}`, name: `ひと${i}` }),
      ),
      submit(ev, "doclose", { shared: "配送料 500", payment: "PayPay 090-1" }),
    ]);

    const { content } = await board(ev, true);
    const people = counted(content);
    // 締め切り後の集金の分母は、生きている注文の件数と必ず一致する
    assert.match(content, new RegExp(`\\*\\*集金\\*\\* 0/${people}`));
    // 均等割の額も同じ人数から計算されている
    assert.match(content, new RegExp(`${people}人で均等割 → ¥${Math.ceil(500 / people)}`));
  });

  test("一斉に「支払った」を押しても集金の数が合う", async () => {
    const ev = nextEvent();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        order(ev, "唐揚げ弁当", 650, { user: `s${i}`, name: `ひと${i}` }),
      ),
    );
    await submit(ev, "doclose", { shared: "", payment: "" });
    await Promise.all(Array.from({ length: 5 }, (_, i) => button(ev, "pay", { user: `s${i}` })));
    assert.match((await board(ev, true)).content, /\*\*集金\*\* 5\/5/);
  });

  test("二人が同時に締め切っても締め切りは1回だけ通る", async () => {
    const ev = nextEvent();
    await order(ev, "唐揚げ弁当", 650, { user: "u1" });
    const res = await Promise.all([
      submit(ev, "doclose", { shared: "配送料 300", payment: "口座A" }, { user: "u1" }),
      submit(ev, "doclose", { shared: "配送料 900", payment: "口座B" }, { user: "u2" }),
    ]);
    const ok = res.filter((r) => r.type === 7);
    const rejected = res.filter((r) => r.type === 4);
    assert.equal(ok.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].data.content, /締め切られています/);

    // 勝ったほうの内容だけが残る。混ざらないこと
    const { content } = await board(ev, true);
    const winner = content.includes("口座A") ? "300" : "900";
    assert.match(content, new RegExp(`配送料 ¥${winner}`));
  });
});
