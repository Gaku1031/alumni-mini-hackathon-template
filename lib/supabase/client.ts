import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/database.types";

import { getSupabaseEnv } from "./env";

/**
 * Client Component（"use client" を付けたファイル）から使う Supabase クライアント。
 *
 * 例:
 *   "use client";
 *   const supabase = createClient();
 *   const { data } = await supabase.from("orders").select();
 */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv();

  return createBrowserClient<Database>(url, publishableKey);
}
