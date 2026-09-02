/**
 * Discord とのやりとりをまとめた薄い層。index.ts からはここだけを使う。
 *
 * 分かれているのは2種類:
 *   - Interactions への「応答」(pong / reply / deferred)。Discord からの POST に返す Response
 *   - Discord API を「こちらから叩く」(postMessage / patchMessage)。Bot Token が要る
 */

const API = "https://discord.com/api/v10";

/** 返す interaction response type */
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const DEFERRED_UPDATE_MESSAGE = 6;
const MODAL = 9;

/** Modal の中身。テキスト欄は1つずつ action row に入れないと Discord が受け付けない */
const ACTION_ROW = 1;
const TEXT_INPUT = 4;
const SHORT = 1;
const PARAGRAPH = 2;

/** 本人にしか見えないメッセージ */
const EPHEMERAL = 64;

export type MessageBody = Record<string, unknown>;

/** Discord API が 2xx 以外を返したとき。status で握り分けられるようにしておく */
export class DiscordApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Discord API ${status}: ${body}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Bot Token は Authorization ヘッダにだけ載せる。ボディには絶対に入れない。
 * 失敗を握りつぶすと「押したのに何も起きない」になるので、必ず投げる。
 */
async function call(token: string, path: string, method: string, body: MessageBody) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new DiscordApiError(res.status, await res.text());
  return (await res.json()) as { id: string };
}

/** チャンネルに投稿する。あとで patchMessage するために message id を返す */
export async function postMessage(
  token: string,
  channelId: string,
  body: MessageBody,
): Promise<string> {
  const message = await call(token, `/channels/${channelId}/messages`, "POST", body);
  return message.id;
}

/** 投稿済みメッセージを差し替える（注文の集計を貼り替えるのに使う） */
export async function patchMessage(
  token: string,
  channelId: string,
  messageId: string,
  body: MessageBody,
): Promise<void> {
  await call(token, `/channels/${channelId}/messages/${messageId}`, "PATCH", body);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** PING への応答 */
export function pong(): Response {
  return json({ type: PONG });
}

/** その場で返せる短い返事。押した本人にしか見せない */
export function reply(content: string): Response {
  return json({ type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
}

/**
 * 押されたことだけ受け取って、その場には何も出さない応答（ボタン／セレクト用）。
 * 見た目は元メッセージの patchMessage で変わるので、type:5 のように
 * 「考え中…」を出してしまうと、消えない吹き出しが残る。
 */
export function ack(): Response {
  return json({ type: DEFERRED_UPDATE_MESSAGE });
}

/** Modal に置くテキスト欄1つぶん */
export type TextField = {
  custom_id: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  /** 複数行にするか */
  paragraph?: boolean;
};

/** 品名・タイトルなど、テキスト欄の並びから Modal のボディを組み立てる */
export function modalBody(customId: string, title: string, fields: TextField[]): MessageBody {
  return {
    custom_id: customId,
    title,
    components: fields.map((field) => ({
      type: ACTION_ROW,
      components: [
        {
          type: TEXT_INPUT,
          style: field.paragraph ? PARAGRAPH : SHORT,
          custom_id: field.custom_id,
          label: field.label,
          required: field.required,
          placeholder: field.placeholder,
        },
      ],
    })),
  };
}

/** Modal 送信で返ってくる入れ子を custom_id → 値 にほぐす */
export type ModalRow = { components?: { custom_id: string; value?: string }[] };

export function modalValues(rows: ModalRow[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of rows) {
    for (const field of row.components ?? []) {
      values[field.custom_id] = field.value ?? "";
    }
  }
  return values;
}

/**
 * 入力用の小窓を開く。組み立て済みの MessageBody をそのまま渡す
 * （modalBody() で作ったものでも、render.ts 側で直接組み立てたものでも良い）。
 * Modal は deferred できない（type:5 を返したあとに開けない）ので、
 * これを返す前に重い処理を挟まないこと。
 */
export function modal(body: MessageBody): Response {
  return json({ type: MODAL, data: body });
}

/**
 * 「受け付けた」とだけ返して画面には何も出さない。
 * 集計メッセージそのものを patchMessage で貼り替えるので、本人向けの返事は要らない。
 * 押したメッセージ由来の interaction（コンポーネント・そこから開いた Modal）でだけ使える。
 */
export function ackUpdate(ctx: ExecutionContext, work: () => Promise<unknown>): Response {
  ctx.waitUntil(work());
  return json({ type: DEFERRED_UPDATE_MESSAGE });
}

/**
 * Discord は3秒で切る。D1 の読み書きや API 呼び出しが挟まる操作はこれで返す。
 * type:5 を即返して「考え中」を出させ、続きは waitUntil に載せる
 * （Response を返したあとも Worker は work が終わるまで生かされる）。
 *
 * work は await しない。ここで待つと3秒制限に戻ってしまう。
 */
export function deferred(ctx: ExecutionContext, work: () => Promise<unknown>): Response {
  ctx.waitUntil(work());
  return json({ type: DEFERRED_CHANNEL_MESSAGE });
}
