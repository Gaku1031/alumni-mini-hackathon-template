/**
 * Discord Interactions のエンドポイント。この Worker が受けるのはここ1本だけ。
 * ルーティングが無いのでフレームワークも入れていない。
 */

import { closeEvent, getEventByMessageId, getPaypayUrl, listOrders } from "./db";
import { deferred, modal, patchMessage, pong, postMessage, reply } from "./discord";
import { CLOSE_MODAL, renderCloseModal, renderClosed } from "./render";
import { parseSharedCosts, splitShared } from "./split";

/** Discord が送ってくる interaction type のうち、使うものだけ */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

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
 * 締め切りの本体。D1 の読み書きと Discord API が2本挟まって3秒に入らないので、
 * deferred から呼んで waitUntil に載せる。
 *
 * @here は「締め切りが通った回」だけ流す。closeEvent が open の行しか更新しないので、
 * 2回目に押されても false が返り、通知も金額の上書きもここで止まる。
 */
async function finishClose(env: Env, messageId: string, input: string): Promise<void> {
  const event = await getEventByMessageId(env.DB, messageId);
  if (!event) return;

  const parsed = parseSharedCosts(input);
  const closed = await closeEvent(env.DB, event.id, parsed);
  // 締め切れなかった（すでに closed）なら、入力は捨てて焼き込み済みの金額で描く
  const sharedCosts = closed ? parsed : event.shared_costs;

  const orders = await listOrders(env.DB, event.id);
  const paypayUrl = await getPaypayUrl(env.DB, event.guild_id);
  const body = renderClosed(
    { ...event, shared_costs: sharedCosts },
    splitShared(sharedCosts, orders),
    paypayUrl,
  );
  await patchMessage(env.DISCORD_BOT_TOKEN, event.channel_id, messageId, body);

  if (!closed) return;
  const link = `https://discord.com/channels/${event.guild_id}/${event.channel_id}/${messageId}`;
  await postMessage(env.DISCORD_BOT_TOKEN, event.channel_id, {
    content: `@here 「${event.title}」を締め切りました。集金を始めます。\n${link}`,
    // @here だけ鳴らす。タイトルに名前や役職が入っていても本人には飛ばさない
    allowed_mentions: { parse: ["everyone"] },
  });
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

    const interaction = JSON.parse(rawBody);

    switch (interaction.type) {
      case PING:
        return pong();

      case MESSAGE_COMPONENT:
        // Modal は即答でしか返せない。ここではまだ何も書き換えない
        // （窓が開いただけで status が変わると、閉じただけで締まってしまう）
        if (interaction.data.custom_id === "close") {
          return modal(renderCloseModal(interaction.message.id));
        }
        return reply("未実装");

      // case の中で const を書くので block にする（switch 直下だと隣の case に漏れる）
      case MODAL_SUBMIT: {
        if (interaction.data.custom_id.startsWith(CLOSE_MODAL)) {
          const messageId = interaction.data.custom_id.slice(CLOSE_MODAL.length);
          // 入力欄は1つだけなので、行と入力を辿って値をそのまま取る
          const input = interaction.data.components[0]?.components[0]?.value ?? "";
          return deferred(ctx, () => finishClose(env, messageId, input));
        }
        return reply("未実装");
      }

      case APPLICATION_COMMAND:
        // ここから先が本体。重い処理を挟むなら discord.ts の deferred(ctx, work) を
        // 返して、あとで patchMessage で元メッセージを差し替える
        return reply("未実装");

      default:
        return new Response("unknown interaction type", { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
