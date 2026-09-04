# お弁当注文Bot

Discord のチャンネルに貼った**1枚のメッセージ**が、注文が入るたびに書き換わる。
注文も集計も集金の管理も、Discord から出ずに終わる。Webサイトは作らない。

技術構成の全体像は [`docs/bento-architecture.html`](docs/bento-architecture.html)（何を使い、どうつながっているか）、
設計の全体像は [`docs/bento-design.html`](docs/bento-design.html)（何を作るか、なぜその形か）、
決定の経緯は [`grill-bento-order-20260902.md`](grill-bento-order-20260902.md)。いずれもブラウザで開く。

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

### 4. Bot をサーバーに入れて、コマンドを登録する

**Installation** タブの `INSTALL LINK` を開いてサーバーに追加する。
権限は **Send Messages**（集計メッセージを投稿する）と **Read Message History** があればよい。
pin を bot にやらせないので `Manage Messages` は要らない。

`/bento` は登録しないと Discord 上に出てこない。`.dev.vars` に2つ足してから登録する。

```
DISCORD_APP_ID=          # General Information の APPLICATION ID
DISCORD_GUILD_ID=        # テスト用サーバーのID（下記）
```

`DISCORD_GUILD_ID` は「ユーザー設定 → 詳細設定 → 開発者モード」をONにしてから、
サーバー名を右クリック →「サーバーIDをコピー」。

```bash
npm run discord:register
```

**GUILD_ID を入れるとそのサーバーだけに即時反映される。**
空にすると全サーバー向けになり、反映に最大1時間かかる。テスト中は必ず入れる。

コマンドの定義（`scripts/register-commands.mjs`）を変えたときだけ打ち直せばよい。
Worker のコードを変えただけなら `npm run deploy` だけでいい。

### 5. Discord で動かす

```
/bento title:9/15(月) お弁当 menu:https://example.com/menu.pdf
```

`menu` はメニューのURL。頼む人がこれを開いて品名を決める。任意なので省いてよく、
そのときは品名を直接入力してもらう。

スラッシュコマンドの任意引数は Discord の画面では気づきにくいので、集計メッセージの
`[メニューを貼る]` からも同じことができる。先にコマンドを打ってしまってから貼っても、
貼り間違えて直しても構わない。

集計メッセージが投稿される。あとはボタンだけで完結する。

1. `[新しく入力]` で品名と金額を入れる → 行が増える
2. 2人目からは `[頼む ▼]` に既出の品が並ぶ（**注文がそのままメニューになる**）
3. `[取り消す ▼]` で誰の注文でも消せる。`[メニューを貼る]` でリンクを後から足せる
4. `[締め切る]` → Modal に**割る費用**と**支払先**を入れる（どちらも空でいい）
   → 均等割した実額に書き変わり、`@here` が1回だけ飛ぶ
5. `[支払った]` で自分が消える。`[未払いに戻す ▼]` で戻せる
6. 押し間違えたら `[再開]` で開き直せる（注文はそのまま残る）

**支払先**は自由文字列。PayPayの電話番号でも、送金リンクでも、振込先の口座でも、
改行して全部並べてもいい。同じサーバーで前回使った値が初期値に入るので、
幹事が同じなら触らずに閉じるだけでよい。

同じ人が2回頼むと**上書き**になる（1人1個。`unique(event_id, discord_user_id)`）。

### 6. ローカル開発

```bash
cp .dev.vars.example .dev.vars   # DISCORD_PUBLIC_KEY / DISCORD_BOT_TOKEN を書く
npm run dev                      # http://127.0.0.1:8787
npm test                         # 署名・注文・締め切り・集金・同時押しを通しで検証
```

Discord から手元へ届かせたい場合は `cloudflared tunnel --url http://127.0.0.1:8787` などで
一時 URL を作り、Interactions Endpoint URL をそちらに向ける。

---

## 自動デプロイ（GitHub Actions）

`.github/workflows/deploy.yml` が入っている。

- **Pull Request**: `npm run check` と `npm test` が走る（デプロイはしない）
- **main に push / マージ**: 上に加えて D1 マイグレーションの本番適用 → `wrangler deploy`

動かすには GitHub リポジトリに secret を2つ登録する。

1. Cloudflare の API トークンを作る
   [ダッシュボード](https://dash.cloudflare.com/profile/api-tokens) → Create Token →
   テンプレート **Edit Cloudflare Workers** を使う。D1 も触るので、Permissions に
   `Account / D1 / Edit` を1行足しておく
2. GitHub の Settings → Secrets and variables → Actions → New repository secret

   | Name | 値 |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | 1 で作ったトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` に出る Account ID |

`DISCORD_PUBLIC_KEY` と `DISCORD_BOT_TOKEN` は Worker 側の secret（`wrangler secret put`）なので、
GitHub には登録しない。デプロイしても消えない。

スラッシュコマンドの登録（`npm run discord:register`）は Actions には入れていない。
コマンドの定義を変えたときだけ手で打つ。

## DB を変更する

```bash
npm run db:new -- add_something   # migrations/000N_add_something.sql が作られる
# SQL を書く（既存のファイルは書き換えない。必ず新しいファイルを足す）
npm run db:apply                  # ローカルに適用
npm run db:apply:remote           # 本番に適用
```

**ローカル（`--local`）とリモート（`--remote`）は別の DB。**
手元で通っても本番にテーブルはできていない。
本番への適用は main に push したときに Actions がやる（手で打つなら `npm run db:apply:remote`）。

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

### Lint / Format

```bash
npm run check       # lint + 整形 + import順（書き換えない）
npm run check:fix   # 自動修正
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
| Bot が「アプリケーションが応答しませんでした」 | 3秒を超えている。`type: 5` を先に返す形に変える |
| `env.DB is undefined` | `wrangler.jsonc` の `database_id` が `PLACEHOLDER` のまま |
| `/bento` が候補に出ない | `npm run discord:register` を打っていない。`DISCORD_GUILD_ID` を空で登録すると最大1時間かかる |
| 集計メッセージが投稿されない | Bot に Send Messages 権限が無いか、`DISCORD_BOT_TOKEN` が本番の secret に入っていない |
| 型が古い | `npm run types`（`wrangler types` の生成物が `worker-configuration.d.ts`） |

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run dev` | ローカルで Worker を起動（127.0.0.1:8787） |
| `npm run deploy` | Cloudflare にデプロイ |
| `npm run db:create` | D1 データベースを作る（初回だけ） |
| `npm run db:new -- <名前>` | 空のマイグレーションファイルを作る |
| `npm run db:apply` | ローカルの D1 にマイグレーションを適用 |
| `npm run db:apply:remote` | 本番の D1 にマイグレーションを適用 |
| `npm run db:console -- "<SQL>"` | ローカルの D1 に SQL を投げる |
| `npm run discord:register` | `/bento` を Discord に登録する |
| `npm run types` | binding から TypeScript の型を再生成 |
| `npm run check` / `check:fix` | Biome |
