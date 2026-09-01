<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# プロジェクトのルール

Next.js + Supabase のスターターテンプレート。セットアップ手順は README.md を参照。

## 構成

- Next.js 16 App Router / React 19 / TypeScript / Tailwind CSS v4
- Supabase（PostgreSQL）。ローカルは Supabase CLI + Docker
- **認証は使わない**
- **ストレージは使わない**
- `src/` ディレクトリは使わない。`app/` `lib/` `types/` がリポジトリ直下

## Next.js

- `middleware.ts` は Next.js 16 で `proxy.ts` にリネームされた。`middleware.ts` を作らないこと
- `cookies()` `headers()` `params` `searchParams` は非同期。`await` する
- データ取得は Server Component が既定。`"use client"` はインタラクションが必要な葉のコンポーネントだけに付ける
- 書き込みは Server Action（`"use server"`）を使う。API Route を新規に作る必要はほぼ無い

## Supabase

- クライアントは必ず既存のものを使う。新たに `createClient` を書かない
  - Server Component / Server Action / Route Handler → `import { createClient } from "@/lib/supabase/server"`（`await createClient()`）
  - Client Component → `import { createClient } from "@/lib/supabase/client"`
- サーバー側のクライアントはリクエストごとに生成する。モジュールのトップレベルで作り置きしない

## DB スキーマの変更

1. `npm run db:new -- <名前>` でマイグレーションファイルを作る
2. SQL を書く（既存のマイグレーションファイルを後から書き換えない。必ず新しいファイルを足す）
3. `npm run db:reset` で反映
4. `npm run db:types` で型を再生成

- Studio の GUI で変更した場合は `npm run db:diff -- <名前>` でマイグレーションに書き出す
- `types/database.types.ts` は生成物。手で編集しない
- 開発用の初期データは `supabase/seed.sql`

## RLS（必須）

新しく作るテーブルには必ず RLS を有効にし、`anon` ロールへのポリシーを書く。
書き忘れるとクエリはエラーにならず**空配列**を返すため、原因が分かりにくい。

```sql
alter table public.<table> enable row level security;
create policy "anon can read <table>"   on public.<table> for select to anon using (true);
create policy "anon can insert <table>" on public.<table> for insert to anon with check (true);
```

## 環境変数

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` のみ
- ローカル用の値は `.env.local.example` にある。新しい変数を足したら両方の `.example` を更新する
- service_role キーはクライアントに渡さない

## Lint / Format

- Biome に一本化している。ESLint と Prettier は入っていない
- コードを書き換えたら `npm run check:fix` を実行し、`npm run check` が通る状態にする
- インデントはスペース2、ダブルクォート、行幅100

## その他

- UI ライブラリは入れない。Tailwind のユーティリティで書く
- 文言は日本語
- 依存パッケージを増やす前に、本当に必要か確認する（軽さ優先）
