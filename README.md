# Next.js × Supabase テンプレート

Next.js + Supabase のスターターです。
Supabase をローカル（Docker）で動かしながら開発し、そのまま Vercel + Supabase（無料枠）にデプロイできます。

アプリ本体は入っていません。
入っているのは「Next.js と Supabase がつながった状態」と「DB を変更する手順」だけです。

## 技術スタック

| | |
|---|---|
| フレームワーク | Next.js 16（App Router） |
| スタイル | Tailwind CSS v4 |
| DB / API | Supabase（PostgreSQL + PostgREST） |
| ホスティング | Vercel |
| Lint / Format | Biome |
| 認証 | **使いません**（後述） |
| ストレージ | **使いません** |

---

## セットアップ

### 前提

- Node.js 20 以上
- Docker が動いていること（Docker Desktop / OrbStack / Rancher Desktop のいずれか）
  - `docker ps` がエラーにならなければOK

### 手順

```bash
npm install
cp .env.local.example .env.local
npm run db:start   # 初回は Docker イメージの取得に5〜10分かかります
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開いて「接続できています」と緑色で出れば成功です。

| URL | 用途 |
|---|---|
| http://localhost:3000 | アプリ |
| http://127.0.0.1:54323 | Supabase Studio（テーブルを GUI で見る・SQL を実行する） |
| http://127.0.0.1:54324 | Mailpit（ローカルで送信されたメールの確認。認証を足したとき用） |

作業を終えるときは `npm run db:stop` で止めてください（データは残ります）。

---

## DB を変更する

**Studio で作ったテーブルはそのままでは他のメンバーに共有されません。**
必ずマイグレーションファイルに残してください。

### 手順1: SQL を自分で書く場合

```bash
npm run db:new -- create_items      # supabase/migrations/<日時>_create_items.sql が作られる
# 作られたファイルに CREATE TABLE などを書く
npm run db:reset                    # DB を作り直して全マイグレーション + seed を流す
npm run db:types                    # TypeScript の型を再生成する
```

### 手順2: Studio の GUI で作った場合

```bash
# Studio でテーブルを作ったあと
npm run db:diff -- create_items     # 差分をマイグレーションファイルに書き出す
npm run db:types
```

### `npm run db:reset` について

ローカルの DB を**作り直します**。手で入れたデータは消えます。
消えると困る初期データは `supabase/seed.sql` に書いてください。リセットのたびに自動で入ります。

---

## RLS（いちばんハマるところ）

Supabase では、RLS（Row Level Security）を有効にしたテーブルは
**ポリシーが無いと「エラーではなく空の配列」が返ります。**
「クエリは成功しているのにデータが出ない」ときは、まずここを疑ってください。

このテンプレートは認証を使わないので、`anon` ロールに対してポリシーを書きます。

```sql
create table public.items (
  id bigint generated always as identity primary key,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.items enable row level security;

create policy "anon can read items"   on public.items for select to anon using (true);
create policy "anon can insert items" on public.items for insert to anon with check (true);
create policy "anon can update items" on public.items for update to anon using (true) with check (true);
create policy "anon can delete items" on public.items for delete to anon using (true);
```

見本が `supabase/migrations/*_init.sql` にあります（`notes` テーブル）。
自分のテーブルを作るときに消して構いません。

> **注意**: 認証を使わない構成なので、デプロイ後の URL を知っている人は誰でもデータを読み書きできます。
> 個人情報や機密情報は入れないでください。

---

## コードの書き方

### Supabase クライアント

用途によって使い分けます。自分で `createClient` を書かず、この2つを使ってください。

```ts
// Server Component / Server Action / Route Handler
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const supabase = await createClient();
  const { data } = await supabase.from("items").select();
  // ...
}
```

```ts
// Client Component（"use client" を付けたファイル）
"use client";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
```

まずは Server Component（`await createClient()`）で書くのがおすすめです。
ボタンのクリックで書き込みたいときは Server Action を使ってください。

### 型

`types/database.types.ts` は `npm run db:types` の生成物です。**手で編集しないでください。**
スキーマを変えたら生成し直せば、`supabase.from("items").select()` の戻り値に型が付きます。

### Lint / Format

Lint も整形も [Biome](https://biomejs.dev/) に一本化しています（ESLint と Prettier は入れていません）。
Next.js・React・Tailwind 向けのルールは Biome のドメイン機能で有効にしてあります。

```bash
npm run check       # lint + 整形 + import順 をまとめて確認（書き換えない）
npm run check:fix   # 上をまとめて自動修正
npm run lint        # lint だけ
npm run format      # 整形だけ
```

保存時に自動整形されるよう `.vscode/settings.json` を入れてあるので、
VS Code なら拡張機能「Biome」を入れるだけで動きます（初回に推奨拡張として案内が出ます）。

`types/database.types.ts` は生成物なので対象から外しています。

---

## デプロイ

### 1. Supabase（本番）

1. [supabase.com](https://supabase.com) でプロジェクトを作る（リージョンは `Northeast Asia (Tokyo)`）
2. DB パスワードは控えておく
3. ローカルのマイグレーションを本番に反映する

```bash
npx supabase login
npm run db:link -- --project-ref <プロジェクトのRef>   # Ref は Supabase の URL に含まれる文字列
npm run db:push
```

`seed.sql` は本番には流れません。初期データが必要なら Studio か SQL Editor で入れてください。

### 2. Vercel

1. GitHub にリポジトリを push する
2. [vercel.com](https://vercel.com) で Import する（設定は変更不要）
3. Environment Variables に以下を設定する

| 変数名 | 取得場所 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase の Project Settings → Data API → API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase の Project Settings → API Keys → Publishable Key |

> **`NEXT_PUBLIC_SUPABASE_URL` は `https://<ref>.supabase.co` の形だけを貼ること。**
> 末尾の `/` や `/rest/v1/` を付けたまま貼ると、実行時に
> `Invalid path specified in request URL（code: PGRST125）` になります。
> （末尾スラッシュや `/rest/v1` はコード側でも除去していますが、貼る時点で外しておくのが確実です）

`.env.example` に空のテンプレートがあります。

> `types/database.types.ts` はコミットしてください。Vercel のビルドでは再生成できません。

### 無料枠の注意

- Supabase の無料プロジェクトは **7日間アクセスが無いと一時停止**します（ダッシュボードから再開可能）
- Supabase の無料プロジェクトは1組織あたり2つまで
- Vercel の Hobby プランは商用利用不可

---

## よくあるトラブル

| 症状 | 対処 |
|---|---|
| 「接続できませんでした」と赤く出る | `npm run db:start` を実行したか、`.env.local` があるか確認 |
| `Invalid path specified in request URL（code: PGRST125）` | `NEXT_PUBLIC_SUPABASE_URL` に `/rest/v1/` や末尾 `/` が付いている。`https://<ref>.supabase.co` だけにして再デプロイ |
| クエリは成功するのにデータが0件 | RLS ポリシーが無い。上の「RLS」を参照 |
| `supabase start` が失敗する | Docker が起動しているか確認。ポート 54321〜54324 が空いているか確認 |
| 型が古いまま | `npm run db:types` を実行し忘れ |
| チームメンバーの DB にテーブルが無い | マイグレーションを作らず Studio で直接作った。`npm run db:diff -- <名前>` |
| `npm run db:reset` でデータが消えた | 仕様です。初期データは `supabase/seed.sql` に書く |

---

## 認証を後から足したくなったら

このテンプレートは認証なしですが、`lib/supabase/server.ts` は Cookie を扱える形で書いてあるので、
以下を足せば動きます。

1. `proxy.ts` をリポジトリ直下に作り、セッション更新を行う
   （**Next.js 16 で `middleware.ts` は `proxy.ts` にリネームされました**。
   ネット上の記事は `middleware.ts` のままのものが多いので注意）
2. ログイン用のページと Server Action を作る
3. RLS ポリシーを `to anon` から `to authenticated` + `auth.uid()` ベースに書き換える

公式ドキュメント: https://supabase.com/docs/guides/auth/server-side/nextjs

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 本番ビルド |
| `npm run check` | Biome で lint + 整形 + import順を確認 |
| `npm run check:fix` | 上をまとめて自動修正 |
| `npm run lint` | lint だけ |
| `npm run format` | 整形だけ |
| `npm run db:start` | ローカル Supabase 起動 |
| `npm run db:stop` | ローカル Supabase 停止 |
| `npm run db:status` | 起動状況と接続情報の表示 |
| `npm run db:reset` | DB を作り直す（migrations + seed） |
| `npm run db:new -- <名前>` | 空のマイグレーションファイルを作る |
| `npm run db:diff -- <名前>` | Studio での変更をマイグレーションに書き出す |
| `npm run db:types` | DB スキーマから TypeScript の型を生成 |
| `npm run db:link -- --project-ref <Ref>` | 本番 Supabase と紐付け |
| `npm run db:push` | 本番 Supabase にマイグレーションを適用 |
