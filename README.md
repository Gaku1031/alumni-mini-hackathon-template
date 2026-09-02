# お弁当注文Bot

Discord のチャンネルに貼った**1枚のメッセージ**が、注文が入るたびに書き換わる。
注文も集計も集金の管理も、Discord から出ずに終わる。Webサイトは作らない。

設計の全体像は [`docs/bento-design.html`](docs/bento-design.html)（ブラウザで開く）、
決定の経緯は [`grill-bento-order-20260902.md`](grill-bento-order-20260902.md)。

## 技術スタック

| | |
|---|---|
| 実行環境 | Cloudflare Workers（TypeScript） |
| DB | Cloudflare D1（SQLite） |
| Lint / Format | Biome |
| 認証 | **使わない**（誰が押したかは Discord が署名付きで送ってくる） |
| ストレージ | **使わない** |

依存パッケージは wrangler / TypeScript / Biome だけ。ランタイムの依存はゼロ。

---

## セットアップ

### 前提

- Node.js 20 以上
- Cloudflare アカウント（無料）
- Discord のサーバー（Bot を入れる先）

### 1. インストールと D1 の作成

```bash
npm install
npx wrangler login
npm run db:create              # 出力された database_id を wrangler.jsonc に貼る
npm run db:apply               # ローカルの D1 にテーブルを作る
```

### 2. Worker をデプロイして URL を確定させる

**Discord の設定より先にデプロイする。** URL が無いと次に進めないため。

```bash
npm run deploy                 # https://bento.<自分の名前>.workers.dev が出る
```

### 3. Discord Application を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application
2. **General Information** の `PUBLIC KEY` を控える
3. **Bot** タブでトークンを発行して控える
4. secret を登録する

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy                 # secret を反映
npm run db:apply:remote        # 本番の D1 にテーブルを作る（ローカルとは別物）
```

5. **General Information** の `INTERACTIONS ENDPOINT URL` に手順2の URL を入れて保存

保存を押すと Discord が疎通確認を投げてくる。**署名検証が通らないと保存できない**。
ここが最初の関門で、`src/index.ts` には通る実装が入っている。

### 4. スラッシュコマンドを登録する

コマンドは Discord 側に登録しないとメッセージ欄に出てこない。

```bash
cp .dev.vars.example .dev.vars   # APPLICATION ID と Bot トークンを書く
npm run register                 # /bento と /bento-setup を登録
```

グローバル登録は反映に最大1時間かかる。開発中は `.dev.vars` の `DISCORD_GUILD_ID` に
テスト用サーバーの ID を入れると、そのサーバーにだけ即時反映される
（サーバー名を右クリック →「サーバーIDをコピー」。開発者モードが要る）。

定義は `scripts/register-commands.mjs` の `COMMANDS`。PUT の一括上書きなので、
**何度実行してもコマンドは重複しない**。定義から消せば Discord 側からも消える。

### 5. ローカル開発

```bash
cp .dev.vars.example .dev.vars   # DISCORD_PUBLIC_KEY / DISCORD_BOT_TOKEN を書く
npm run dev                      # http://127.0.0.1:8787
node --test test/interaction.test.mjs   # 署名検証の自己チェック（別ターミナルで dev 起動中に）
node --test test/register-commands.test.mjs   # コマンド定義の自己チェック
```

Discord から手元へ届かせたい場合は `cloudflared tunnel --url http://127.0.0.1:8787` などで
一時 URL を作り、Interactions Endpoint URL をそちらに向ける。

---

## DB を変更する

```bash
npm run db:new -- add_something   # migrations/000N_add_something.sql が作られる
# SQL を書く（既存のファイルは書き換えない。必ず新しいファイルを足す）
npm run db:apply                  # ローカルに適用
npm run db:apply:remote           # 本番に適用
```

**ローカル（`--local`）とリモート（`--remote`）は別の DB。**
手元で通っても本番にテーブルはできていない。デプロイのたびに両方打つ癖をつける。

中身を覗くとき:

```bash
npm run db:console -- "select * from bento_orders"
```

### D1 は SQLite

PostgreSQL の書き方は通らない。`uuid` `boolean` `jsonb` `timestamptz` は無い。

| やりたいこと | SQLite での書き方 |
|---|---|
| ID | `text primary key` に `crypto.randomUUID()` を入れる |
| 真偽値 | `integer` の `0` / `1` |
| JSON | `text` に入れて読むとき `JSON.parse` |
| 日時 | `text not null default (datetime('now'))` |

スキーマは `migrations/0001_init.sql`。

---

## コードの書き方

### D1

`wrangler.jsonc` の binding 経由でしか触れない。**外向きの URL も API キーも無い。**

```ts
const rows = await env.DB.prepare(
  "select * from bento_orders where event_id = ?",
).bind(eventId).all();
```

これがこのアプリのセキュリティの中心にある。
署名検証を通らないリクエストは、そもそもデータベースに到達する経路を持たない。
**公開 API を足すと、この保証が消える。**

### Discord Interactions で踏む3つの地雷

1. **生ボディが要る。** `await req.text()` で受けて検証してから `JSON.parse`。
   先に `req.json()` を呼ぶと署名検証ができなくなる
2. **3秒で切られる。** D1 の読み書き＋Discord API への PATCH が挟まる操作は
   `type: 5`(deferred) を先に返し、`ctx.waitUntil()` で続きを回す
3. **PING を返し忘れない。** `type: 1` が来たら `{ type: 1 }` を返す。これが Endpoint 登録の疎通確認

### Lint / Format / 型

```bash
npm run check       # lint + 整形 + import順（書き換えない）
npm run check:fix   # 自動修正
npm run typecheck   # TypeScript の型チェック（tsc --noEmit）
npm test            # test/*.test.mjs をまとめて実行
```

保存時に自動整形されるよう `.vscode/settings.json` を入れてある。
VS Code なら拡張機能「Biome」を入れるだけで動く。

---

## 無料枠

- Workers: 10万リクエスト/日
- D1: 5GB / 500万行読み取り per day
- **休止しない。** 使わない期間が空いても、次に叩いたときそのまま動く

---

## よくあるトラブル

| 症状 | 対処 |
|---|---|
| Interactions Endpoint URL が保存できない | 署名検証が通っていない。`req.text()` より先に `req.json()` を呼んでいないか、`DISCORD_PUBLIC_KEY` が本番に登録されているか |
| 本番だけ `no such table` | `npm run db:apply:remote` を打っていない |
| `/bento` が候補に出てこない | `npm run register` を打っていない。グローバル登録は反映に最大1時間かかるので、開発中は `DISCORD_GUILD_ID` を指定する |
| Bot が「アプリケーションが応答しませんでした」 | 3秒を超えている。`type: 5` を先に返す形に変える |
| `env.DB is undefined` | `wrangler.jsonc` の `database_id` が `PLACEHOLDER` のまま |
| 型が古い | `npm run types`（`wrangler types` の生成物が `worker-configuration.d.ts`） |

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run dev` | ローカルで Worker を起動（127.0.0.1:8787） |
| `npm run deploy` | Cloudflare にデプロイ |
| `npm run register` | スラッシュコマンドを Discord に登録（一括上書き。重複しない） |
| `npm run db:create` | D1 データベースを作る（初回だけ） |
| `npm run db:new -- <名前>` | 空のマイグレーションファイルを作る |
| `npm run db:apply` | ローカルの D1 にマイグレーションを適用 |
| `npm run db:apply:remote` | 本番の D1 にマイグレーションを適用 |
| `npm run db:console -- "<SQL>"` | ローカルの D1 に SQL を投げる |
| `npm run types` | binding から TypeScript の型を再生成 |
| `npm run check` / `check:fix` | Biome |
| `npm run typecheck` | TypeScript の型チェック |
| `npm test` | テストをまとめて実行 |
