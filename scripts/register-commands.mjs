/**
 * スラッシュコマンドを Discord に登録する。
 *
 *   npm run register                       # グローバル（全サーバー。反映に最大1時間）
 *   DISCORD_GUILD_ID=... npm run register   # そのサーバーだけ（即時。開発中はこちら）
 *
 * PUT の一括上書きなので、何度実行してもコマンドは重複しない。
 * COMMANDS から消したコマンドは Discord 側からも消える。
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";

/** option の type。使うのは文字列だけ */
const STRING = 3;
/** contexts。0 = サーバー内。DM では guild_id が無くて成立しない */
const GUILD = 0;

export const COMMANDS = [
  {
    name: "bento",
    description: "お弁当の注文をこのチャンネルで募集する",
    // 日付とメニューURLはコマンドの引数ではなくモーダルで受ける（docs/bento-design.html）
    options: [],
    contexts: [GUILD],
  },
  {
    name: "bento-setup",
    description: "集金に使う PayPay のリンクをこのサーバーに登録する",
    options: [
      {
        type: STRING,
        name: "paypay_url",
        description: "PayPay の送金リンク（https://pay.paypay.ne.jp/...）",
        required: true,
      },
    ],
    contexts: [GUILD],
  },
];

/** .dev.vars を読む。ローカルの secret はここに置いてあるので使い回す */
function loadDevVars() {
  let text;
  try {
    text = readFileSync(".dev.vars", "utf8");
  } catch {
    return {};
  }
  const vars = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

/**
 * 送信するコマンド定義を作る。
 * `contexts` はグローバル登録専用のフィールドで、ギルドコマンドは元からそのサーバー限定なので、
 * 付けたまま送ると Discord に 400 で弾かれる。
 */
export function commandsFor(guildId) {
  if (!guildId) return COMMANDS;
  return COMMANDS.map((command) => {
    const guildCommand = { ...command };
    delete guildCommand.contexts;
    return guildCommand;
  });
}

/**
 * COMMANDS をまるごと Discord に反映する。
 * POST（1件ずつ追加）ではなく PUT（一括上書き）を使うのが肝で、
 * これで再実行してもコマンドが重複しない。
 */
export async function register({ applicationId, botToken, guildId, fetch = globalThis.fetch }) {
  const url = guildId
    ? `${API}/applications/${applicationId}/guilds/${guildId}/commands`
    : `${API}/applications/${applicationId}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commandsFor(guildId)),
  });
  if (!res.ok) {
    throw new Error(`Discord API が ${res.status} を返した: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const env = { ...loadDevVars(), ...process.env };
  const missing = ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN"].filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`環境変数が足りない: ${missing.join(", ")}`);
    console.error("Discord Developer Portal の General Information にある APPLICATION ID と、");
    console.error("Bot タブのトークンを .dev.vars に書くか、環境変数で渡す:");
    console.error("  DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register");
    process.exit(1);
  }

  const guildId = env.DISCORD_GUILD_ID;
  const registered = await register({
    applicationId: env.DISCORD_APPLICATION_ID,
    botToken: env.DISCORD_BOT_TOKEN,
    guildId,
  });
  const names = registered.map((c) => `/${c.name}`).join(" ");
  const where = guildId ? `guild ${guildId}` : "グローバル。反映に最大1時間";
  console.log(`${registered.length} 件のコマンドを登録した（${where}）: ${names}`);
}

// テストから import されたときは実行しない
const thisFile = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === thisFile) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
