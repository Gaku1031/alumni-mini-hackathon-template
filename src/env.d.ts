/**
 * secret の型。
 *
 * `wrangler types` が作る Env は wrangler.jsonc の binding と `.dev.vars` から組み立てられる。
 * secret は wrangler.jsonc に書かない方針で、`.dev.vars` は gitignore してあるので、
 * 手元にファイルがある人の環境でしか型が付かない。ここに書いてどこでも同じにする。
 * 実体は `wrangler secret put`（本番）と `.dev.vars`（ローカル）。
 */
interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
}
