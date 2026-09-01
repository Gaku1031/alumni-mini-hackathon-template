/**
 * Supabase の接続情報を環境変数から読み出す。
 *
 * `process.env.NEXT_PUBLIC_*` はビルド時に値へ置換されるため、
 * 必ずこの形（プロパティを直接書く）で参照すること。変数経由だと置換されない。
 */
export function getSupabaseEnv() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!rawUrl || !publishableKey) {
    throw new Error(
      "Supabase の環境変数が設定されていません。" +
        "`cp .env.local.example .env.local` を実行してから開発サーバーを再起動してください。",
    );
  }

  // ダッシュボードから REST エンドポイント（.../rest/v1）や末尾スラッシュ付きの
  // URL をコピーしてしまうと PGRST125（Invalid path）になるため正規化する。
  // 必要なのは Project URL（https://<ref>.supabase.co）だけ。
  const url = rawUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/, "");

  return { url, publishableKey };
}
