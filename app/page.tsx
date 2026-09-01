import { createClient } from "@/lib/supabase/server";

// Supabase から毎回読み直す（ビルド時に固定させない）。
export const dynamic = "force-dynamic";

type Note = {
  id: number;
  title: string;
  created_at: string;
};

type FetchResult = { ok: true; notes: Note[] } | { ok: false; message: string; hint: string };

async function fetchNotes(): Promise<FetchResult> {
  let supabase: Awaited<ReturnType<typeof createClient>>;

  try {
    supabase = await createClient();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      hint: "cp .env.local.example .env.local",
    };
  }

  const { data, error } = await supabase.from("notes").select("id, title, created_at").order("id");

  if (error) {
    return {
      ok: false,
      message: `${error.message}（code: ${error.code ?? "-"}）`,
      hint: "npm run db:start",
    };
  }

  return { ok: true, notes: data ?? [] };
}

export default async function Home() {
  const result = await fetchNotes();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-bold">Next.js × Supabase テンプレート</h1>
      <p className="mt-2 text-sm opacity-70">このページは疎通確認用です。</p>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Supabase との接続</h2>

        {result.ok ? (
          <div className="mt-4 rounded-lg border border-green-600/40 bg-green-600/10 p-4">
            <p className="font-medium text-green-700 dark:text-green-400">
              接続できています（notes テーブルから {result.notes.length} 件取得）
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {result.notes.map((note) => (
                <li key={note.id} className="flex gap-2">
                  <span className="opacity-50 tabular-nums">{note.id}.</span>
                  <span>{note.title}</span>
                </li>
              ))}
            </ul>
            {result.notes.length === 0 && (
              <p className="mt-3 text-sm opacity-70">
                行が0件です。RLS ポリシーが無いテーブルはエラーではなく空で返ります。
                <code className="mx-1 rounded bg-black/10 px-1 dark:bg-white/10">
                  npm run db:reset
                </code>
                を試してください。
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-red-600/40 bg-red-600/10 p-4">
            <p className="font-medium text-red-700 dark:text-red-400">接続できませんでした</p>
            <p className="mt-2 text-sm break-words">{result.message}</p>
            <p className="mt-3 text-sm">
              まずこれを試してください:
              <code className="mx-1 rounded bg-black/10 px-1 dark:bg-white/10">{result.hint}</code>
            </p>
            <p className="mt-1 text-sm opacity-70">
              詳しい手順は README.md の「セットアップ」を参照してください。
            </p>
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">次にやること</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>
            <code className="rounded bg-black/10 px-1 dark:bg-white/10">supabase/migrations/</code>
            のサンプル（notes）を消して、自分たちのテーブルを設計する
          </li>
          <li>
            <code className="rounded bg-black/10 px-1 dark:bg-white/10">
              npm run db:new -- create_items
            </code>
            でマイグレーションを作り、SQL を書く
          </li>
          <li>
            <code className="rounded bg-black/10 px-1 dark:bg-white/10">npm run db:reset</code>
            で反映し、
            <code className="mx-1 rounded bg-black/10 px-1 dark:bg-white/10">npm run db:types</code>
            で TypeScript の型を生成する
          </li>
          <li>このページを書き換えて、アプリを作り始める</li>
        </ol>
      </section>

      <section className="mt-10 text-sm opacity-70">
        <p>
          ローカルの Supabase Studio:{" "}
          <a
            className="underline"
            href="http://127.0.0.1:54323"
            target="_blank"
            rel="noreferrer noopener"
          >
            http://127.0.0.1:54323
          </a>
        </p>
      </section>
    </main>
  );
}
