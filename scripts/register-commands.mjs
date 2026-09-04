/**
 * /bento をDiscordに登録する。コマンドの定義を変えたときだけ打てばよい。
 *
 *   node scripts/register-commands.mjs
 *
 * 鍵は .dev.vars から読む。DISCORD_APP_ID と DISCORD_BOT_TOKEN が要る。
 * DISCORD_GUILD_ID があればそのサーバー限定で登録する（反映が即時）。
 * 無ければ全サーバー向け（反映に最大1時間かかる）。テスト中は GUILD_ID を入れる。
 */
import { readFileSync } from "node:fs";

const env = { ...process.env };
try {
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
} catch {
  // .dev.vars が無ければ環境変数だけで動かす
}

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
  console.error(
    "DISCORD_APP_ID と DISCORD_BOT_TOKEN が要る。.dev.vars に書くか環境変数で渡す。\n" +
      "APP_ID は Developer Portal の General Information の APPLICATION ID。",
  );
  process.exit(1);
}

const commands = [
  {
    name: "bento",
    description: "お弁当の注文をはじめる",
    options: [
      { type: 3, name: "title", description: "例: 9/15(月) お弁当", required: true },
      {
        type: 3,
        name: "menu",
        description: "メニューのURL。頼む人がこれを開いて品名を決める（無くてもいい）",
        required: false,
      },
    ],
  },
];

const path = DISCORD_GUILD_ID
  ? `/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `/applications/${DISCORD_APP_ID}/commands`;

const res = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: {
    authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`失敗 ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(
  DISCORD_GUILD_ID
    ? `登録した（サーバー ${DISCORD_GUILD_ID} 限定・即時反映）`
    : "登録した（全サーバー向け・反映に最大1時間）",
);
