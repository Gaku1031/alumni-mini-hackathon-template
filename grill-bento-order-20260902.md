# grill-me 合意メモ: アルムナイ弁当注文&集計ツール

作成日: 2026-09-02

## 結論

### 価値の柱

Googleフォームに勝つ一点は、**チャンネルにpinされた1枚のメッセージが、注文が入るたびに書き換わり続けること**。
スクロールするだけで「誰が何を頼んだか」「未払いは誰か」が全部見える。
フォームは回答後に結果が見えないので、構造的にこれを真似できない。

副の柱は集金の可視化。**「人にお金の催促をする」という幹事の一番嫌な仕事を、名指しの状態表示に置き換える**（通知は飛ばさない）。

### 落としたもの

- 締切後の変更・キャンセル対応（例外は考えない）
- 数量（1人1個固定。`unique(event_id, discord_user_id)` で構造的に担保）
- 幹事によるメニュー登録 → **注文がそのままメニューになる**
- 締切時刻・日時パース・自動締切・cron・リマインド → **手動の [締め切る] ボタン1つ**
- 権限チェック / `creator_id`（悪用されない前提。誰でも取り消せる・未払いに戻せる）
- システムへのAI組み込み（AI活用＝AIを使って開発すること、と確認済み。**LLM APIを叩く箇所はゼロ**）
- Webページ（デプロイするのは Worker 1本だけ）

### 画面（これが製品のすべて）

```
注文フェーズ
──────────────────────────────────────
📌 9/15(月) お弁当
📎 メニュー: https://tenpo.example.com/bento

🍱 唐揚げ弁当  ¥650   ×3   gaku, taro, hana
🍱 のり弁      ¥480   ×2   jiro, saki
🍱 幕の内      ¥820   ×1   kenta
──────────────────────────────────────
弁当代 ¥4,310

  [ 頼む ▼ ]  [ 新しく入力 ]  [ 取り消す ▼ ]  [ 締め切る ]
```

`[締め切る]` → Modal で「みんなで割る費用」を入力（改行区切り `配送料 500` / `API代 300`、空欄可）
→ 金額確定 → `@here` で1回だけ通知 → 集金フェーズへ。

```
集金フェーズ
──────────────────────────────────────
📌 9/15(月) お弁当

🍱 唐揚げ弁当  ¥650 + ¥84 = ¥734   ×3   gaku, taro, hana
🍱 のり弁      ¥480 + ¥84 = ¥564   ×2   jiro, saki
🍱 幕の内      ¥820 + ¥84 = ¥904   ×1   kenta
──────────────────────────────────────
弁当代 ¥4,310 ＋ 配送料 ¥500 = ¥4,810
配送料は6人で均等割 → ¥84（端数切り上げ・余り¥4は幹事）

💰 集金 4/6      未払い: jiro, saki       ← 通知は飛ばさない表示のみ
送金先 → https://paypay.me/xxxx

  [ 支払った ]  [ 未払いに戻す ▼ ]
```

**配送料は均等割だが、弁当の値段が違うので各自の支払額は全員バラバラ。**
品ごとにグルーピングしているので、行に実額を出せば全員分カバーできる。暗算ゼロ。

### ボタンの仕様

| ボタン | 誰が | 動き |
|---|---|---|
| `[ 頼む ▼ ]` | 全員 | 既出の品が並ぶ。1タップ。**選択肢0件なら非表示** |
| `[ 新しく入力 ]` | 全員 | Modal（品名 / 金額）。最初の1人と、珍しいものを頼む人だけ |
| `[ 取り消す ▼ ]` | 全員 | 全員の注文が並ぶ。誰のでも消せる（打ち間違いの修正手段を兼ねる） |
| `[ 締め切る ]` | 全員 | Modalが開く＝実質2段階確認なので誤爆しない |
| `[ 支払った ]` | 本人 | PayPay送金は本人がその場で完了させる行為なので自己申告で足りる |
| `[ 未払いに戻す ▼ ]` | 全員 | 齟齬の修正 |

金額のバリデーションはしない。表に出ているので人間が気づく。
上限を決め打つと、高い弁当や「2人分まとめて」が弾かれてそちらの害が大きい。

## 技術選定: Cloudflare Workers + D1

Vercel + Supabase から変更した。理由は2つ。

1. **Supabase Free は7日間アクセスが無いと休止する。** このBotは月1回動くかどうかなので、使いたい当日に落ちている可能性がある。keepalive の cron を持つのは、cron を消したこの設計と噛み合わない
2. **Supabase の公開 Data API は、Discord の署名検証を迂回する裏口になる。** anon キーで直接テーブルを叩けば、注文の捏造も削除もできる。D1 は binding 経由でしか触れないので、この穴が構造的に存在しない

Worker のコードは `src/index.ts` 1本、DB は `env.DB`。無料枠は 10万リクエスト/日。

## スキーマ

D1（中身は SQLite）。実体は `migrations/0001_init.sql`。

```sql
create table bento_events (
  id           text primary key,
  guild_id     text not null,
  channel_id   text not null,
  message_id   text,                     -- 集計メッセージ。edit の対象
  title        text not null,
  menu_url     text,
  status       text not null default 'open' check (status in ('open', 'closed')),
  shared_costs text not null default '[]',  -- JSON: [{"label":"配送料","amount":500}]
  created_at   text not null default (datetime('now'))
);

create table bento_orders (
  id              text primary key,
  event_id        text not null references bento_events(id) on delete cascade,
  discord_user_id text not null,
  display_name    text not null,
  item_name       text not null,
  price           integer not null,
  paid            integer not null default 0,  -- SQLite に boolean は無い。0/1
  created_at      text not null default (datetime('now')),
  unique (event_id, discord_user_id)           -- 1人1個を構造で担保
);

-- 集計メッセージを描くたびに event_id で全件引くので必須
create index idx_bento_orders_event on bento_orders (event_id);

create table guild_settings (
  guild_id   text primary key,
  paypay_url text
);
```

**メニュー用のテーブルは作らない。**
選択肢は `select distinct item_name, price from bento_orders where event_id = ?` で出る。
これが「注文がメニューになる」の実体。

SQLite なので Postgres の書き方は通らない。`uuid` / `boolean` / `jsonb` / `timestamptz` は無い。
ID は `crypto.randomUUID()` をアプリ側で作って `text` に入れる。真偽値は 0/1、JSON は文字列で持って読むとき `JSON.parse`。

**RLS は書かない。書く相手がいない。**
D1 には外向きの URL も API キーも無く、`wrangler.jsonc` の binding を持つ Worker から `env.DB` 経由でしか触れない。
署名検証を通らないリクエストは、そもそも DB に到達する経路を持たない。

## 技術メモ（実装時に踏む地雷）

- **署名検証が必須**。Discord は Ed25519 で署名を送る。Workers ランタイムの `crypto.subtle` が Ed25519 に対応しているので**依存パッケージは足さない**
- **生ボディが要る**。`await req.text()` してから検証 → その後 `JSON.parse`。先に `req.json()` すると検証できない
- **3秒ルール**。Worker はコールドスタートが無いので単純な応答は余裕で間に合うが、D1 の読み書き＋Discord API への PATCH が挟まる操作は `type: 5`(deferred) を返し、`ctx.waitUntil()` で続きを回して元メッセージを PATCH する
- **D1 はローカルとリモートが別物**。`npm run db:apply`（手元）と `npm run db:apply:remote`（本番）は両方打つ。手元で通ったから本番にテーブルがある、にはならない
- **secret は `.dev.vars`（手元）と `wrangler secret put`（本番）**。`DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN` の2つ。`wrangler.jsonc` の `vars` に書かない

## 残った前提・未決事項

- [ ] Discord Application の作成と Interactions Endpoint URL 設定（**先に `npm run deploy` しないと `*.workers.dev` の URL が確定しない**）
- [ ] `guild_settings.paypay_url` の入れ方。`/bento-setup` を作るか、最初の `/bento` の Modal に混ぜるか
- [ ] `display_name` の保存タイミング。Discordのニックネームは変わるので、注文時点の名前を焼き込む前提でよいか
- [ ] 集計メッセージの pin を bot が自動でやるか、幹事に任せるか（botに `Manage Messages` 権限が必要）
- [ ] 同じチャンネルで注文イベントが同時に2つ走った場合。破綻はしないが pin が2枚になって紛らわしい

## 次のアクション

1. `npm run db:create` → 出た `database_id` を `wrangler.jsonc` に貼る → `npm run deploy` で URL を確定させる
2. Discord Application を作り、Interactions Endpoint URL を設定 → **PING応答だけ実装して検証を通す**（`src/index.ts` に実装済み。`node --test test/interaction.test.mjs` で手元検証できる）
3. マイグレーション3テーブル → `npm run db:apply` → `npm run db:apply:remote`
4. `/bento` → Modal → 集計メッセージ投稿までを一直線に通す
5. `[新しく入力]` → `[頼む ▼]` の順に注文導線
6. `[締め切る]` → 割り勘計算 → 集金モード
7. `[支払った]` / `[取り消す ▼]` / `[未払いに戻す ▼]`

**2番が最大の関門**（署名検証・生ボディ・3秒）。ここを最初に単独で通すこと。
