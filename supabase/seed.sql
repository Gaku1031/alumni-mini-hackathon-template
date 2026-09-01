-- `npm run db:reset` のたびに流し込まれる開発用データ。
-- 本番（Supabase のクラウド側）には流れません。
insert into public.notes (title) values
  ('Supabase につながっています 🎉'),
  ('このデータは supabase/seed.sql から入っています'),
  ('スキーマを変えたら npm run db:types で型を作り直してください');
