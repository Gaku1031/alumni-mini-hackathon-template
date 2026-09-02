/**
 * src/discord.ts の自己チェック。fetch をスタブに差し替えて、
 * 「Discord に何をどう投げたか」を実際のネットワーク無しで見る。
 *
 *   node --test test/discord.test.mjs
 *
 * wrangler も node_modules も要らない（署名検証側は interaction.test.mjs が見ている）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeCtx, installFetchStub } from "./helpers/fetch-stub.mjs";

/**
 * Node は .ts をそのままは読めないので、型だけ落として読み込む。
 * ビルド成果物ではなくソースそのものを見たいので、変換もその場でやる。
 */
const source = readFileSync(fileURLToPath(new URL("../src/discord.ts", import.meta.url)), "utf8");
const { DiscordApiError, deferred, patchMessage, postMessage, pong, reply } = await import(
  `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`
);

const TOKEN = "test-bot-token";

test("postMessage は Bot Token 付きで POST し、message id を返す", async () => {
  const stub = installFetchStub([{ body: { id: "1234567890" } }]);
  try {
    const id = await postMessage(TOKEN, "555", { content: "きょうのお弁当" });

    assert.equal(id, "1234567890");
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, "https://discord.com/api/v10/channels/555/messages");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, `Bot ${TOKEN}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(call.body), { content: "きょうのお弁当" });
  } finally {
    stub.restore();
  }
});

test("patchMessage が PATCH /channels/{id}/messages/{message_id} を呼ぶ", async () => {
  const stub = installFetchStub([{ body: { id: "999" } }]);
  try {
    await patchMessage(TOKEN, "555", "999", { content: "締め切りました" });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, "https://discord.com/api/v10/channels/555/messages/999");
    assert.equal(call.method, "PATCH");
    assert.equal(call.headers.authorization, `Bot ${TOKEN}`);
    assert.deepEqual(JSON.parse(call.body), { content: "締め切りました" });
  } finally {
    stub.restore();
  }
});

test("deferred は即座に type:5 を返し、後続処理を waitUntil に渡す", async () => {
  const ctx = fakeCtx();
  let done = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const res = deferred(ctx, async () => {
    await gate;
    done = true;
  });

  // 応答は後続処理の完了を待たない。ここで待っていたら3秒制限に間に合わない
  assert.deepEqual(await res.json(), { type: 5 });
  assert.equal(done, false);
  assert.equal(ctx.pending.length, 1);

  release();
  await ctx.settle();
  assert.equal(done, true);
});

test("deferred の後続処理でも postMessage が使える（waitUntil 経由）", async () => {
  const stub = installFetchStub([{ body: { id: "42" } }]);
  const ctx = fakeCtx();
  try {
    let posted;
    deferred(ctx, async () => {
      posted = await postMessage(TOKEN, "555", { content: "集計しました" });
    });
    await ctx.settle();

    assert.equal(posted, "42");
    assert.equal(stub.calls[0].method, "POST");
  } finally {
    stub.restore();
  }
});

test("Discord API が 4xx を返したら例外になる（握りつぶさない）", async () => {
  const stub = installFetchStub([{ status: 403, body: { message: "Missing Access" } }]);
  try {
    await assert.rejects(
      () => postMessage(TOKEN, "555", { content: "x" }),
      (err) => {
        assert.ok(err instanceof DiscordApiError);
        assert.equal(err.status, 403);
        assert.match(err.body, /Missing Access/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test("patchMessage の 4xx も呼び出し元に伝わる", async () => {
  const stub = installFetchStub([{ status: 404, body: { message: "Unknown Message" } }]);
  try {
    await assert.rejects(
      () => patchMessage(TOKEN, "555", "999", { content: "x" }),
      (err) => err.status === 404,
    );
  } finally {
    stub.restore();
  }
});

// トークンが漏れると誰でも Bot として投稿できる。ボディに混ぜないのはもちろん、
// 失敗時の例外メッセージ（ログに出る）にも入れない
test("Bot Token がリクエストボディにも例外メッセージにも入らない", async () => {
  const stub = installFetchStub([{ status: 401, body: { message: "401: Unauthorized" } }]);
  try {
    await assert.rejects(
      () => postMessage(TOKEN, "555", { content: "x" }),
      (err) => {
        assert.ok(!err.message.includes(TOKEN));
        assert.ok(!String(err.stack).includes(TOKEN));
        return true;
      },
    );
    const [call] = stub.calls;
    assert.ok(!call.body.includes(TOKEN));
    assert.ok(!call.url.includes(TOKEN));
    // 載ってよいのは Authorization ヘッダだけ
    assert.equal(call.headers.authorization, `Bot ${TOKEN}`);
  } finally {
    stub.restore();
  }
});

test("interaction への応答にも Bot Token は出てこない", async () => {
  const bodies = [await pong().json(), await reply("受け付けました").json()];
  for (const body of bodies) {
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  }
  assert.deepEqual(bodies[0], { type: 1 });
  assert.deepEqual(bodies[1], { type: 4, data: { content: "受け付けました", flags: 64 } });
});
