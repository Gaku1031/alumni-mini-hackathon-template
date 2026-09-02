/**
 * node:sqlite の上に D1 (env.DB) と同じ形の口を被せる。
 * migrations/ を全部当てたインメモリの DB が立つので、wrangler を起動せずに
 * src/db.ts をそのまま動かせる。
 *
 *   const db = createTestDb();
 *   await createEvent(db, { ... });
 *   db.close();
 *
 * 使うのは prepare().bind() → first() / all() / run() だけ。
 * D1 の batch() や exec() は src/db.ts が使っていないので生やしていない。
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

export function createTestDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }

  return {
    prepare(sql) {
      return statement(sqlite.prepare(sql), []);
    },
    close() {
      sqlite.close();
    },
  };
}

/** bind() は自分を書き換えず新しい文を返す。D1 と同じく使い回せる */
function statement(stmt, args) {
  return {
    bind: (...next) => statement(stmt, next),

    /** 1行目。無ければ null。列名を渡すとその値だけ */
    async first(column) {
      const row = stmt.get(...args) ?? null;
      if (column === undefined || row === null) return row;
      return row[column] ?? null;
    },

    async all() {
      return { results: stmt.all(...args), success: true, meta: {} };
    },

    async run() {
      const { changes, lastInsertRowid } = stmt.run(...args);
      return {
        success: true,
        meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) },
      };
    },
  };
}
