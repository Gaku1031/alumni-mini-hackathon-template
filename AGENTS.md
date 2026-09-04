# プロジェクトのルール

Discord のお弁当注文Bot。設計は `docs/bento-design.html` と `grill-bento-order-20260902.md`。
セットアップ手順は README.md を参照。

## 構成

- Cloudflare Workers（TypeScript）+ D1（SQLite）
- Worker は `src/index.ts` の1本だけ。ルーティングが要らないのでフレームワークは入れない
- Discord の Interactions Webhook を受けるだけ。**Webページは持たない**
- **認証は使わない**（誰が押したかは Discord が署名付きで送ってくる）
- **ストレージは使わない**
- **LLM API を叩く箇所は無い**

## Workers

- エントリは `export default { fetch(req, env, ctx) }`。Node.js の API を前提にしない
- 署名検証には**生ボディ**が要る。`await req.text()` してから検証し、そのあと `JSON.parse` する。
  先に `req.json()` を呼ぶと検証できなくなる
- Ed25519 の検証は `crypto.subtle`（Workers ランタイムに入っている）。**ライブラリを足さない**
- Discord は3秒で切る。D1 の読み書き＋Discord API への PATCH が挟まる操作は
  `type: 5`(deferred) を先に返し、`ctx.waitUntil()` で続きを回す

## D1

- アクセスは binding 経由のみ（`env.DB`）。接続文字列も API キーも無い。
  **外向きの口が無いこと自体がこの設計のセキュリティ**なので、公開 API を足さない
- SQLite。`uuid` `boolean` `jsonb` `timestamptz` は無い。
  ID は `crypto.randomUUID()` を `text` に、真偽値は `0`/`1`、JSON は文字列で持って `JSON.parse`
- クエリは必ずプレースホルダ。`env.DB.prepare("... where id = ?").bind(id)`

## DB スキーマの変更

1. `npm run db:new -- <名前>` でマイグレーションファイルを作る
2. SQL を書く（既存のマイグレーションファイルを後から書き換えない。必ず新しいファイルを足す）
3. `npm run db:apply`（ローカル）→ 本番は main に push すれば GitHub Actions が適用する
   （手で入れるなら `npm run db:apply:remote`）

**ローカルとリモートは別の DB。** 手元で通っても本番にテーブルはできていない。

## デプロイ

- `.github/workflows/deploy.yml` が main への push で `check` → `test` → D1 マイグレーション → `wrangler deploy` を回す
- PR では check と test だけ走る。デプロイはしない
- 手で `npm run deploy` を打つ必要は無い

## 環境変数 / secret

- `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN` の2つだけ
- ローカルは `.dev.vars`（gitignore 済み。雛形は `.dev.vars.example`）
- 本番は `wrangler secret put <名前>`。**`wrangler.jsonc` の `vars` に書かない**
- `worker-configuration.d.ts` は `wrangler types` の生成物。手で編集しない

## Lint / Format

- Biome に一本化している。ESLint と Prettier は入っていない
- コードを書き換えたら `npm run check:fix` を実行し、`npm run check` が通る状態にする
- インデントはスペース2、ダブルクォート、行幅100

## その他

- 文言は日本語
- 依存パッケージを増やす前に、本当に必要か確認する（軽さ優先）
