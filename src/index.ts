/**
 * Discord Interactions のエンドポイント。この Worker が受けるのはここ1本だけ。
 * ルーティングが無いのでフレームワークも入れていない。
 */

import { createEvent, setMessageId } from "./db";
import type { ModalRow } from "./discord";
import { modal, modalValues, pong, postMessage, reply } from "./discord";
import { renderOpen } from "./render";

/** Discord が送ってくる interaction type のうち、使うものだけ */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

/** `/bento` で開く Modal。送信されたときにこの custom_id で戻ってくる */
const CREATE_MODAL = "create_event";

/** 受け取る側で見るところだけ書いた interaction。全部は要らない */
type Interaction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    components?: ModalRow[];
  };
};

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Discord は Ed25519 署名を付けてくる。検証に失敗したら 401 を返さないと
 * Endpoint URL の登録自体が通らない。
 * 署名対象は timestamp + 生ボディ。JSON.parse 済みの文字列では検証できない。
 */
async function verifySignature(req: Request, rawBody: string, publicKey: string) {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    hexToBytes(signature),
    new TextEncoder().encode(timestamp + rawBody),
  );
}

/**
 * 募集を1件立てて、空の集計メッセージをチャンネルに貼る。
 * 投稿して初めて message_id が決まるので、貼ったあとに書き戻す。
 * これが以降の「1枚を書き換え続ける」の書き換え対象になる。
 */
async function openEvent(
  env: Env,
  input: { guildId: string; channelId: string; title: string; menuUrl: string | null },
): Promise<void> {
  const eventId = await createEvent(env.DB, input);
  const message = renderOpen({ title: input.title, menu_url: input.menuUrl }, []);
  const messageId = await postMessage(env.DISCORD_BOT_TOKEN, input.channelId, message);
  await setMessageId(env.DB, eventId, messageId);
}

/** `/bento` は Modal を開くだけ。D1 も Discord API も触らないので即返せる */
function handleCommand(interaction: Interaction): Response {
  if (interaction.data?.name !== "bento") return reply("未実装");

  return modal(CREATE_MODAL, "お弁当の募集", [
    { custom_id: "title", label: "タイトル", placeholder: "9/15(月) お弁当", required: true },
    {
      custom_id: "menu_url",
      label: "メニューのURL（任意）",
      placeholder: "https://tenpo.example.com/bento",
      required: false,
    },
  ]);
}

function handleModal(interaction: Interaction, env: Env, ctx: ExecutionContext): Response {
  if (interaction.data?.custom_id !== CREATE_MODAL) return reply("未実装");

  const values = modalValues(interaction.data.components);
  const title = (values.title ?? "").trim();
  // Modal 側でも required にしてあるが、空白だけの入力はそこを素通りする
  if (title === "") return reply("タイトルを入力してください。");

  const { guild_id: guildId, channel_id: channelId } = interaction;
  if (!guildId || !channelId) return reply("サーバーのチャンネルで実行してください。");

  const menuUrl = (values.menu_url ?? "").trim() || null;

  // Discord は3秒で切る。D1 の書き込みと投稿は待たずに返し、続きは waitUntil で回す
  ctx.waitUntil(openEvent(env, { guildId, channelId, title, menuUrl }));
  return reply(`「${title}」の募集をこのチャンネルに出しました。`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Discord は POST しか投げてこない。それ以外は受け付けない
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    // 生ボディが要る。先に req.json() すると署名検証ができなくなる
    const rawBody = await req.text();
    if (!(await verifySignature(req, rawBody, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction: Interaction = JSON.parse(rawBody);

    switch (interaction.type) {
      case PING:
        return pong();

      case APPLICATION_COMMAND:
        return handleCommand(interaction);

      case MODAL_SUBMIT:
        return handleModal(interaction, env, ctx);

      case MESSAGE_COMPONENT:
        // ここから先が本体。重い処理を挟むなら discord.ts の deferred(ctx, work) を
        // 返して、あとで patchMessage で元メッセージを差し替える
        return reply("未実装");

      default:
        return new Response("unknown interaction type", { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
