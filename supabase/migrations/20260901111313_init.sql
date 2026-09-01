-- 疎通確認用のサンプルテーブル。
-- アプリの実装を始めるときに、このファイルごと消して作り直して構いません。
--
-- 【重要】このテンプレートは認証を使いません。
-- Supabase では RLS を有効にしたテーブルはポリシーが無いと「行が0件」で返ります
-- （エラーにならないので原因に気づきにくい、いちばんよくあるハマりどころです）。
-- 認証なしの構成では、下のように anon ロールに対してポリシーを書いてください。

create table public.notes (
  id bigint generated always as identity primary key,
  title text not null,
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "anon can read notes"
  on public.notes for select
  to anon
  using (true);

create policy "anon can insert notes"
  on public.notes for insert
  to anon
  with check (true);
