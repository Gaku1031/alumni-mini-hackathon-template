import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database.types";

import { getSupabaseEnv } from "./env";

/**
 * Server Component / Server Action / Route Handler から使う Supabase クライアント。
 *
 * 必ずリクエストごとに呼び出すこと（モジュールのトップレベルで作り置きしない）。
 *
 * 例:
 *   const supabase = await createClient();
 *   const { data } = await supabase.from("orders").select();
 */
export async function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からは Cookie を書き込めないため例外になる。
          // 認証を使わない構成では無視して問題ない。
          // 認証を足す場合は proxy.ts でセッションを更新する。README を参照。
        }
      },
    },
  });
}
