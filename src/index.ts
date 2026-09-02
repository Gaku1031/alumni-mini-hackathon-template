/**
 * Discord Interactions のエンドポイント。この Worker が受けるのはここ1本だけ。
 * ルーティングが無いのでフレームワークも入れていない。
 */

import { addOrder, createEvent, getEventByMessage, listOrders, setMessageId } from "./db";
import type { ModalRow } from "./discord";
import {
  ackUpdate,
  modal,
  modalBody,
  modalValues,
  patchMessage,
  pong,
  postMessage,
  reply,
} from "./discord";
import { newItemModal, renderOpen } from "./render";

/** Discord が送ってくる interaction type のうち、使うものだけ */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

/** `[新しく入力]` のボタンと、そこから開く Modal（`new_item:<元メッセージ id>`） */
const NEW_ITEM = "new_item";

/** `/bento` で開く Modal。送信されたときにこの custom_id で戻ってくる */
const CREATE_MODAL = "create_event";

/** 使う分だけ。Discord の payload を全部写しても読めるものは増えない */
type DiscordUser = { id: string; username: string; global_name?: string | null };

/** 受け取る側で見るところだけ書いた interaction。全部は要らない */
type Interaction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    /** Modal の入力欄。ACTION_ROW の中に1つずつ入っている */
    components?: ModalRow[];
  };
  message?: { id: string };
  member?: { nick?: string | null; user: DiscordUser };
  user?: DiscordUser;
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

/** 押した人。ギルド内なら member、DM なら user から来る */
function actor(interaction: Interaction): { id: string; name: string } {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return { id: "unknown", name: "?" };
  // サーバー内のニックネームが本人の見えている名前なので、あればそれを使う
  return { id: user.id, name: interaction.member?.nick || user.global_name || user.username };
}

/**
 * 金額。上限も相場も見ない（桁を間違えても集計メッセージに出るので人間が気づく）が、
 * 数値として読めないものは入れない。「¥1,200」「１２００円」までは読む。
 */
function parsePrice(input: string): number | null {
  const digits = input
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[¥￥,、\s円]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
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

  return modal(
    modalBody(CREATE_MODAL, "お弁当の募集", [
      { custom_id: "title", label: "タイトル", placeholder: "9/15(月) お弁当", required: true },
      {
        custom_id: "menu_url",
        label: "メニューのURL（任意）",
        placeholder: "https://tenpo.example.com/bento",
        required: false,
      },
    ]),
  );
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

/**
 * `[新しく入力]` の Modal 送信。ここで入った品が次の人の `[頼む ▼]` の選択肢になる。
 *
 * D1 は速いので読み書きはこの場で終わらせ、遅い Discord API の PATCH だけ waitUntil に載せる。
 * 断るとき（金額が読めない・締め切り済み・すでに注文済み）は本人にだけ見える返事で止める。
 */
async function handleNewItem(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const fields = modalValues(interaction.data?.components);
  const itemName = (fields.item_name ?? "").trim();
  const price = parsePrice(fields.price ?? "");
  if (!itemName) return reply("品名を入れてください");
  if (price === null) return reply("金額は数字で入れてください（例: 650）");

  const messageId = (interaction.data?.custom_id ?? "").slice(NEW_ITEM.length + 1);
  const event = await getEventByMessage(env.DB, messageId);
  if (!event) return reply("この集計メッセージのイベントが見つかりません");
  if (event.status === "closed") return reply("この弁当は締め切り済みです");

  const who = actor(interaction);
  const added = await addOrder(env.DB, {
    eventId: event.id,
    discordUserId: who.id,
    displayName: who.name,
    itemName,
    price,
  });
  // 1人1個。入れ直したいときは [取り消す ▼] で消してもらう
  if (!added.ok)
    return reply("すでに頼んでいます。変えるときは [取り消す ▼] で消してから入れ直してください");

  return ackUpdate(ctx, async () => {
    const orders = await listOrders(env.DB, event.id);
    const body = renderOpen(event, orders);
    await patchMessage(env.DISCORD_BOT_TOKEN, event.channel_id, messageId, body);
  });
}

/**
 * 署名検証を通ったあとの本体。押されたものごとに分岐する。
 * 署名の検証と切り離してあるので、この関数は interaction をそのまま渡せばテストできる。
 */
export async function handleInteraction(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";

  switch (interaction.type) {
    case PING:
      return pong();

    case APPLICATION_COMMAND:
      return handleCommand(interaction);

    case MESSAGE_COMPONENT:
      // Modal は deferred できない。DB を触らず、あとで引けるように
      // 元メッセージの id だけ持たせて即返す
      if (customId === NEW_ITEM) return modal(newItemModal(interaction.message?.id ?? ""));
      return reply("未実装");

    case MODAL_SUBMIT:
      if (customId === CREATE_MODAL) return handleModal(interaction, env, ctx);
      if (customId.startsWith(`${NEW_ITEM}:`)) return handleNewItem(interaction, env, ctx);
      return reply("未実装");

    default:
      return new Response("unknown interaction type", { status: 400 });
  }
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

    return handleInteraction(JSON.parse(rawBody), env, ctx);
  },
} satisfies ExportedHandler<Env>;
