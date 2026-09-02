/**
 * マイグレーションの自己チェック。
 * D1 は SQLite なので、node 同梱の node:sqlite に同じ SQL を流して制約を確かめる。
 * wrangler も D1 も要らないので手元で完結する。
 *
 *   node --test test/migration.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** どこから実行されても同じ場所を見るよう、cwd ではなくこのファイルからの相対で解決する */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "migrations");

const WANT = ["bento_events", "bento_orders", "guild_settings", "idx_bento_orders_event"];

const INSERT_EVENT = `insert into bento_events
  (id, guild_id, channel_id, title, status)
  values (?, ?, ?, ?, ?)`;

const INSERT_ORDER = `insert into bento_orders
  (id, event_id, discord_user_id, display_name, item_name, price)
  values (?, ?, ?, ?, ?, ?)`;

/** migrations/*.sql をファイル名順に流した DB を返す */
function migrated() {
  const db = new DatabaseSync(":memory:");
  // SQLite の外部キーは既定で無効。D1 は有効なので合わせる
  db.exec("pragma foreign_keys = on");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  for (const f of files.sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

function addEvent(db, id = "e1", status = "open") {
  db.prepare(INSERT_EVENT).run(id, "g1", "c1", "から揚げ弁当", status);
  return id;
}

function addOrder(db, eventId, userId, orderId) {
  db.prepare(INSERT_ORDER).run(orderId, eventId, userId, "たろう", "から揚げ", 600);
}

test("3テーブルと索引ができる", () => {
  const db = migrated();
  const rows = db.prepare("select name from sqlite_master").all();
  const names = rows.map((r) => r.name);
  for (const n of WANT) {
    assert.ok(names.includes(n), `${n} が無い: ${names.join(", ")}`);
  }
});

test("同じイベントに同じ人は2回注文できない", () => {
  const db = migrated();
  const e = addEvent(db);
  addOrder(db, e, "u1", "o1");
  assert.throws(() => addOrder(db, e, "u1", "o2"), /UNIQUE/i);
});

test("別イベントなら同じ人でも注文できる", () => {
  const db = migrated();
  addOrder(db, addEvent(db, "e1"), "u1", "o1");
  addOrder(db, addEvent(db, "e2"), "u1", "o2");
});

test("status は open / closed 以外を受け付けない", () => {
  const db = migrated();
  assert.throws(() => addEvent(db, "e9", "paid"), /CHECK/i);
});

test("イベントを消すと注文も消える", () => {
  const db = migrated();
  const e = addEvent(db);
  addOrder(db, e, "u1", "o1");
  db.prepare("delete from bento_events where id = ?").run(e);
  const { n } = db.prepare("select count(*) as n from bento_orders").get();
  assert.equal(Number(n), 0);
});

test("db スクリプトが揃っていて local と remote が別コマンド", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const s of ["db:create", "db:new", "db:apply", "db:apply:remote"]) {
    assert.ok(pkg.scripts[s], `${s} が package.json に無い`);
  }
  assert.notEqual(pkg.scripts["db:apply"], pkg.scripts["db:apply:remote"]);
  assert.match(pkg.scripts["db:apply"], /--local/);
  assert.match(pkg.scripts["db:apply:remote"], /--remote/);
});
