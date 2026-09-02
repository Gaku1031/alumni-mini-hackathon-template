/**
 * コマンド登録スクリプトの自己チェック。Discord には一切繋がない。
 *   node --test test/register-commands.test.mjs
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COMMANDS, register } from "../scripts/register-commands.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/register-commands.mjs", import.meta.url));
const run = promisify(execFile);

// https://discord.com/developers/docs/interactions/application-commands
// 名前は英小文字・数字・ハイフン・アンダースコアのみ。大文字は弾かれる
const NAME = /^[-_a-z0-9]{1,32}$/;

function assertName(name, where) {
  assert.match(name, NAME, `${where}: 名前が Discord の制約に合わない`);
  assert.equal(name, name.toLowerCase(), `${where}: 名前に大文字が入っている`);
}

function assertDescription(description, where) {
  assert.equal(typeof description, "string", `${where}: description が無い`);
  assert.ok(
    description.length >= 1 && description.length <= 100,
    `${where}: description は1〜100文字`,
  );
}

test("コマンド定義が Discord のスキーマ制約を満たす", () => {
  assert.ok(COMMANDS.length > 0);
  assert.ok(
    COMMANDS.some((c) => c.name === "bento"),
    "/bento が定義されていない",
  );

  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "コマンド名が重複している");

  for (const command of COMMANDS) {
    assertName(command.name, command.name);
    assertDescription(command.description, command.name);

    const options = command.options ?? [];
    assert.ok(Array.isArray(options), `${command.name}: options が配列でない`);
    assert.ok(options.length <= 25, `${command.name}: options は25個まで`);

    const optionNames = options.map((o) => o.name);
    assert.equal(
      new Set(optionNames).size,
      optionNames.length,
      `${command.name}: option 名が重複している`,
    );

    let seenOptional = false;
    for (const option of options) {
      const where = `${command.name} の ${option.name}`;
      assertName(option.name, where);
      assertDescription(option.description, where);
      assert.ok(
        Number.isInteger(option.type) && option.type >= 1 && option.type <= 11,
        `${where}: option の type が不正`,
      );
      // 必須オプションは任意オプションより前に置かないと Discord に拒否される
      if (option.required) {
        assert.equal(seenOptional, false, `${where}: 必須オプションが任意オプションより後にある`);
      } else {
        seenOptional = true;
      }
    }
  }
});

test("環境変数が無ければ非0で終了し、何を設定すべきか stderr に出す", async () => {
  const env = { ...process.env };
  for (const name of ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"]) {
    delete env[name];
  }
  // .dev.vars を拾わせないために、リポジトリの外で動かす
  const err = await run("node", [SCRIPT], { env, cwd: tmpdir() }).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "環境変数が無いのに成功してしまった");
  assert.notEqual(err.code, 0);
  assert.match(err.stderr, /DISCORD_APPLICATION_ID/);
  assert.match(err.stderr, /DISCORD_BOT_TOKEN/);
});

test("PUT の一括上書きなので、繰り返しても重複しない", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => JSON.parse(init.body) };
  };

  const args = { applicationId: "123", botToken: "dummy", fetch: fakeFetch };
  await register(args);
  await register(args);

  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(init.method, "PUT", "PUT でないとコマンドが積み上がる");
    assert.equal(url, "https://discord.com/api/v10/applications/123/commands");
    // 一括上書き: 毎回すべてのコマンドを送る
    assert.deepEqual(JSON.parse(init.body), COMMANDS);
    assert.equal(init.headers.authorization, "Bot dummy");
  }
  // 2回目の送信内容が1回目と同じ = 実行を繰り返しても Discord 側の状態は変わらない
  assert.equal(calls[0].init.body, calls[1].init.body);
});

test("DISCORD_GUILD_ID があればそのサーバー向けの URL に送る", async () => {
  let sent;
  await register({
    applicationId: "123",
    botToken: "dummy",
    guildId: "456",
    fetch: async (url, init) => {
      sent = url;
      return { ok: true, status: 200, json: async () => JSON.parse(init.body) };
    },
  });
  assert.equal(sent, "https://discord.com/api/v10/applications/123/guilds/456/commands");
});

test("package.json に register スクリプトがある", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.scripts.register, "register スクリプトが無い");
  assert.match(pkg.scripts.register, /scripts\/register-commands\.mjs/);
});
