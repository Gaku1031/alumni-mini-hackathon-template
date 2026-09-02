/**
 * Discord Interactions のエンドポイント。この Worker が受けるのはここ1本だけ。
 * ルーティングが無いのでフレームワークも入れていない。
 */

import type { BentoEvent } from "./db";
import { createEvent, getEventByMessageId, listOrders, setMessageId, setOrder } from "./db";
import type { ModalRow } from "./discord";
import { ack, modal, modalValues, patchMessage, pong, postMessage, reply } from "./discord";
import { renderOpen } from "./render";

/** Discord が送ってくる interaction type のうち、使うものだけ */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

/** `/bento` で開く Modal。送信されたときにこの custom_id で戻ってくる */
const CREATE_MODAL = "create_event";

/** `[頼む ▼]` のセレクト */
const ORDER_SELECT = "order_select";

/** 押した人。ギルド内なら member に入っていて、Discord が署名付きで送ってくる */
type Member = {
  nick?: string | null;
  user?: { id?: string; username?: string; global_name?: string | null };
};

/** 受け取る側で見るところだけ書いた interaction。全部は要らない */
type Interaction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: Member;
  /** ボタン／セレクトが置かれていたメッセージ。これでイベントを引く */
  message?: { id?: string };
  data?: {
    name?: string;
    custom_id?: string;
    components?: ModalRow[];
    /** セレクトで選ばれた option の value */
    values?: string[];
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

/** 表示名。サーバー内のニックネームがあればそれを優先する */
function nameOf(member: Member | undefined): string {
  const user = member?.user;
  return member?.nick || user?.global_name || user?.username || "名無し";
}

/** `[頼む ▼]` の value は `650:唐揚げ弁当`。品名に ":" が入っていても最初の1個で割れる */
function parseItem(value: string): { itemName: string; price: number } | null {
  const at = value.indexOf(":");
  if (at < 0) return null;
  const price = Number.parseInt(value.slice(0, at), 10);
  const itemName = value.slice(at + 1);
  if (!Number.isInteger(price) || itemName === "") return null;
  return { itemName, price };
}

/** 注文を1件入れて、集計メッセージを描き直す。ここが `[頼む ▼]` の実体 */
async function placeOrder(
  env: Env,
  event: BentoEvent,
  messageId: string,
  input: { discordUserId: string; displayName: string; itemName: string; price: number },
): Promise<void> {
  await setOrder(env.DB, { eventId: event.id, ...input });
  const orders = await listOrders(env.DB, event.id);
  const body = renderOpen(event, orders);
  await patchMessage(env.DISCORD_BOT_TOKEN, event.channel_id, messageId, body);
}

/** ボタンとセレクト。いまは `[頼む ▼]` だけ */
async function handleComponent(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (interaction.data?.custom_id !== ORDER_SELECT) return reply("未実装");

  const item = parseItem(interaction.data.values?.[0] ?? "");
  const userId = interaction.member?.user?.id;
  const messageId = interaction.message?.id;
  if (!item || !userId || !messageId) return reply("注文できませんでした。");

  // 締め切り済みかどうかはここで見る。ack で返してしまうと拒否を伝える先が無くなる。
  // D1 の読み1回なら3秒に収まる
  const event = await getEventByMessageId(env.DB, messageId);
  if (!event) return reply("この募集は見つかりませんでした。");
  if (event.status === "closed") return reply("この募集はもう締め切られています。");

  // 書き込みと Discord への PATCH は待たない
  ctx.waitUntil(
    placeOrder(env, event, messageId, {
      discordUserId: userId,
      displayName: nameOf(interaction.member),
      ...item,
    }),
  );
  return ack();
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
        return handleComponent(interaction, env, ctx);

      default:
        return new Response("unknown interaction type", { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
