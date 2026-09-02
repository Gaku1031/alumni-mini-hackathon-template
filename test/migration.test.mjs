/**
 * マイグレーションの自己チェック。
 * D1 は SQLite なので、node 同梱の node:sqlite に同じ SQL を流して制約を確かめる。
 * wrangler も D1 も要らないので手元で一瞬で回る。
 *
 *   node --test test/migration.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = "migrations";

/** migrations/*.sql をファイル名順に流した DB を返す */
function migrated() {
  const db = new DatabaseSync(":memory:");
  // SQLite の外部キーは既定で無効。D1 は有効なので合わせる
  db.exec("pragma foreign_keys = on");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

function newEvent(db, id = "e1") {
  db.prepare("insert into bento_events (id, guild_id, channel_id, title) values (?, ?, ?, ?)").run(
    id,
    "g1",
    "c1",
    "から揚げ弁当",
  );
  return id;
}

function newOrder(db, eventId, userId, orderId) {
  db.prepare(
    `insert into bento_orders (id, event_id, discord_user_id, display_name, item_name, price)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(orderId, eventId, userId, "たろう", "から揚げ", 600);
}

test("3テーブルと索引ができる", () => {
  const db = migrated();
  const names = db
    .prepare("select name from sqlite_master where name not like 'sqlite_%' order by name")
    .all()
    .map((r) => r.name);
  for (const n of [
    "bento_events",
    "bento_orders",
    "guild_settings",
    "idx_bento_orders_event",
  ]) {
    assert.ok(names.includes(n), `${n} が無い: ${names.join(", ")}`);
  }
});

test("同じイベントに同じ人は2回注文できない", () => {
  const db = migrated();
  const e = newEvent(db);
  newOrder(db, e, "u1", "o1");
  assert.throws(() => newOrder(db, e, "u1", "o2"), /UNIQUE/i);
});

test("別イベントなら同じ人でも注文できる", () => {
  const db = migrated();
  newOrder(db, newEvent(db, "e1"), "u1", "o1");
  newOrder(db, newEvent(db, "e2"), "u1", "o2");
});

test("status は open / closed 以外を受け付けない", () => {
  const db = migrated();
  assert.throws(
    () =>
      db
        .prepare(
          "insert into bento_events (id, guild_id, channel_id, title, status) values (?, ?, ?, ?, ?)",
        )
        .run("e9", "g1", "c1", "弁当", "paid"),
    /CHECK/i,
  );
});

test("イベントを消すと注文も消える", () => {
  const db = migrated();
  const e = newEvent(db);
  newOrder(db, e, "u1", "o1");
  db.prepare("delete from bento_events where id = ?").run(e);
  const { n } = db.prepare("select count(*) as n from bento_orders").get();
  assert.equal(n, 0);
});

test("db スクリプトが揃っていて local と remote が別コマンド", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const s of ["db:create", "db:new", "db:apply", "db:apply:remote"]) {
    assert.ok(scripts[s], `${s} が package.json に無い`);
  }
  assert.notEqual(scripts["db:apply"], scripts["db:apply:remote"]);
  assert.match(scripts["db:apply"], /--local/);
  assert.match(scripts["db:apply:remote"], /--remote/);
});
