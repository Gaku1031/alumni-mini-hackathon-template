/**
 * Discord Interactions のエンドポイント。この Worker が受けるのはここ1本だけ。
 * ルーティングが無いのでフレームワークも入れていない。
 */

/** Discord が送ってくる interaction type のうち、使うものだけ */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

/** 返す type */
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const UPDATE_MESSAGE = 7;
const MODAL = 9;

const EPHEMERAL = 64;

const API = "https://discord.com/api/v10";

type BentoEvent = {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  menu_url: string | null;
  status: "open" | "closed";
  shared_costs: string;
};

type BentoOrder = {
  id: string;
  event_id: string;
  discord_user_id: string;
  display_name: string;
  item_name: string;
  price: number;
  paid: number;
};

type SharedCost = { label: string; amount: number };

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

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** 本人にだけ見える返事。エラーの通知はすべてこれ */
function reply(content: string) {
  return json({ type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
}

function yen(n: number) {
  return `¥${n.toLocaleString("en-US")}`;
}

/** interaction を送ってきた人の、そのサーバーでの表示名 */
// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
function displayName(interaction: any) {
  const m = interaction.member;
  return m?.nick || m?.user?.global_name || m?.user?.username || "unknown";
}

// biome-ignore lint/suspicious/noExplicitAny: 同上
function userId(interaction: any): string {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

async function discord(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`discord ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * 集計メッセージの本体。注文が入るたびにこれを描き直して差し替える。
 * 品名+価格でグルーピングするので、行に実額を出せば全員分の支払額がカバーできる。
 */
function render(ev: BentoEvent, orders: BentoOrder[], paypayUrl: string | null) {
  const shared: SharedCost[] = JSON.parse(ev.shared_costs);
  const sharedTotal = shared.reduce((s, c) => s + c.amount, 0);
  // 端数は切り上げ。余りは幹事が飲む（合意メモの通り）
  const perHead = orders.length > 0 ? Math.ceil(sharedTotal / orders.length) : 0;
  const closed = ev.status === "closed";

  const lines = [`📌 **${ev.title}**`];
  if (ev.menu_url) lines.push(`📎 メニュー: ${ev.menu_url}`);
  lines.push("");

  const groups = new Map<string, BentoOrder[]>();
  for (const o of orders) {
    const key = `${o.item_name} ${o.price}`;
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }

  if (groups.size === 0) lines.push("_まだ注文がありません_");

  for (const list of groups.values()) {
    const o = list[0];
    const amount =
      closed && perHead > 0
        ? `${yen(o.price)} + ${yen(perHead)} = **${yen(o.price + perHead)}**`
        : yen(o.price);
    const names = list.map((x) => x.display_name).join(", ");
    lines.push(`🍱 ${o.item_name}  ${amount}  ×${list.length}  ${names}`);
  }

  lines.push("──────────────────────────────");

  const bentoTotal = orders.reduce((s, o) => s + o.price, 0);
  if (closed && sharedTotal > 0) {
    const breakdown = shared.map((c) => `${c.label} ${yen(c.amount)}`).join("　＋　");
    lines.push(`弁当代 ${yen(bentoTotal)}　＋　${breakdown}　=　${yen(bentoTotal + sharedTotal)}`);
    const labels = shared.map((c) => c.label).join("・");
    lines.push(`${labels}は${orders.length}人で均等割 → ${yen(perHead)}（端数切り上げ）`);
  } else {
    lines.push(`弁当代 ${yen(bentoTotal)}`);
  }

  if (closed) {
    const unpaid = orders.filter((o) => o.paid === 0);
    lines.push("");
    lines.push(`💰 集金 ${orders.length - unpaid.length}/${orders.length}`);
    if (unpaid.length > 0) lines.push(`未払い: ${unpaid.map((o) => o.display_name).join(", ")}`);
    if (paypayUrl) lines.push(`送金先 → ${paypayUrl}`);
  }

  return lines.join("\n");
}

function components(ev: BentoEvent, orders: BentoOrder[]) {
  const rows: unknown[] = [];

  if (ev.status === "open") {
    // 既出の品がそのままメニューになる。メニュー用のテーブルは持たない
    const menu = new Map<string, BentoOrder>();
    for (const o of orders) menu.set(`${o.item_name} ${o.price}`, o);

    if (menu.size > 0) {
      rows.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `pick:${ev.id}`,
            placeholder: "頼む",
            options: [...menu.values()].slice(0, 25).map((o) => ({
              label: `${o.item_name} ${yen(o.price)}`.slice(0, 100),
              value: `${o.price}:${o.item_name}`.slice(0, 100),
            })),
          },
        ],
      });
    }

    if (orders.length > 0) {
      rows.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `cancel:${ev.id}`,
            placeholder: "取り消す",
            options: orders.slice(0, 25).map((o) => ({
              label: `${o.display_name} / ${o.item_name}`.slice(0, 100),
              value: o.id,
            })),
          },
        ],
      });
    }

    rows.push({
      type: 1,
      components: [
        { type: 2, style: 1, label: "新しく入力", custom_id: `new:${ev.id}` },
        { type: 2, style: 4, label: "締め切る", custom_id: `close:${ev.id}` },
      ],
    });
  } else {
    const paid = orders.filter((o) => o.paid === 1);
    if (paid.length > 0) {
      rows.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `unpay:${ev.id}`,
            placeholder: "未払いに戻す",
            options: paid.slice(0, 25).map((o) => ({
              label: `${o.display_name} / ${o.item_name}`.slice(0, 100),
              value: o.id,
            })),
          },
        ],
      });
    }

    rows.push({
      type: 1,
      components: [{ type: 2, style: 3, label: "支払った", custom_id: `pay:${ev.id}` }],
    });
  }

  return rows;
}

/** DB を引いて集計メッセージを組み立てる。ボタンを押すたびに毎回これを通る */
async function board(env: Env, eventId: string) {
  const ev = await env.DB.prepare("select * from bento_events where id = ?")
    .bind(eventId)
    .first<BentoEvent>();
  if (!ev) return null;

  const { results } = await env.DB.prepare(
    "select * from bento_orders where event_id = ? order by created_at",
  )
    .bind(eventId)
    .all<BentoOrder>();

  const settings = await env.DB.prepare("select paypay_url from guild_settings where guild_id = ?")
    .bind(ev.guild_id)
    .first<{ paypay_url: string | null }>();

  return {
    content: render(ev, results, settings?.paypay_url ?? null),
    components: components(ev, results),
  };
}

/** 押した先のイベントがもう無いとき。押した本人にだけ返す */
function gone() {
  return reply("この募集はもうありません。");
}

/** 更新後の集計メッセージで、押された元メッセージをそのまま差し替える */
async function updated(env: Env, eventId: string) {
  const payload = await board(env, eventId);
  if (!payload) return gone();
  return json({ type: UPDATE_MESSAGE, data: payload });
}

/** `/bento` — イベントを作り、集計メッセージをチャンネルに投稿する */
// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
function createEvent(interaction: any, env: Env, ctx: ExecutionContext) {
  const opts = new Map<string, string>(
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    (interaction.data.options ?? []).map((o: any) => [o.name, o.value]),
  );
  const eventId = crypto.randomUUID();

  /** 「考え中...」の ephemeral を書き換える。成否どちらも本人だけに見える */
  const note = (content: string) =>
    fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });

  ctx.waitUntil(
    (async () => {
      const paypay = opts.get("paypay");
      if (paypay) {
        await env.DB.prepare(
          "insert into guild_settings (guild_id, paypay_url) values (?, ?) on conflict(guild_id) do update set paypay_url = excluded.paypay_url",
        )
          .bind(interaction.guild_id, paypay)
          .run();
      }

      await env.DB.prepare(
        "insert into bento_events (id, guild_id, channel_id, title, menu_url) values (?, ?, ?, ?, ?)",
      )
        .bind(
          eventId,
          interaction.guild_id,
          interaction.channel_id,
          opts.get("title") ?? "お弁当",
          opts.get("menu") ?? null,
        )
        .run();

      // 集計メッセージは interaction の返事ではなく通常のメッセージとして投稿する。
      // interaction のトークンは15分で切れるが、通常のメッセージは何時間でも編集できる
      const msg = (await discord(
        `/channels/${interaction.channel_id}/messages`,
        env.DISCORD_BOT_TOKEN,
        { method: "POST", body: JSON.stringify(await board(env, eventId)) },
      )) as { id: string };

      await env.DB.prepare("update bento_events set message_id = ? where id = ?")
        .bind(msg.id, eventId)
        .run();

      await note("作成しました。上のメッセージを pin しておくと便利です。");
    })().catch((e) =>
      // 権限不足やトークン切れはここに来る。黙って消えると原因が分からないので本人に返す
      note(`作成できませんでした: ${e}`),
    ),
  );

  // 3秒ルール。D1 の書き込みと Discord への POST が挟まるので先に deferred を返す
  return json({ type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

/** 品名と金額の入力欄。custom_id に event_id を載せて次の MODAL_SUBMIT まで運ぶ */
function itemModal(eventId: string) {
  return json({
    type: MODAL,
    data: {
      custom_id: `newitem:${eventId}`,
      title: "注文を入力",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "item_name",
              label: "品名",
              style: 1,
              max_length: 60,
              required: true,
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "price",
              label: "金額（数字だけ）",
              style: 1,
              max_length: 8,
              required: true,
            },
          ],
        },
      ],
    },
  });
}

function closeModal(eventId: string) {
  return json({
    type: MODAL,
    data: {
      custom_id: `doclose:${eventId}`,
      title: "締め切る",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "shared",
              label: "みんなで割る費用（1行に「名前 金額」）",
              style: 2,
              placeholder: "配送料 500",
              required: false,
            },
          ],
        },
      ],
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
function modalValue(interaction: any, id: string): string {
  for (const row of interaction.data.components ?? []) {
    for (const c of row.components ?? []) {
      if (c.custom_id === id) return (c.value ?? "").trim();
    }
  }
  return "";
}

/** 注文を1件入れる。unique(event_id, discord_user_id) があるので2回目は上書きになる */
async function upsertOrder(
  env: Env,
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  interaction: any,
  eventId: string,
  name: string,
  price: number,
) {
  await env.DB.prepare(
    `insert into bento_orders (id, event_id, discord_user_id, display_name, item_name, price)
     values (?, ?, ?, ?, ?, ?)
     on conflict(event_id, discord_user_id) do update set
       display_name = excluded.display_name,
       item_name = excluded.item_name,
       price = excluded.price`,
  )
    .bind(crypto.randomUUID(), eventId, userId(interaction), displayName(interaction), name, price)
    .run();
}

// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
async function handleComponent(interaction: any, env: Env) {
  const [action, eventId] = interaction.data.custom_id.split(":");

  const ev = await env.DB.prepare("select id from bento_events where id = ?")
    .bind(eventId)
    .first<{ id: string }>();
  if (!ev) return gone();

  switch (action) {
    case "new":
      return itemModal(eventId);

    case "close":
      return closeModal(eventId);

    case "pick": {
      // value は "650:唐揚げ弁当"。品名にコロンが入っても壊れないよう最初の1個で切る
      const raw: string = interaction.data.values[0];
      const sep = raw.indexOf(":");
      const price = Number.parseInt(raw.slice(0, sep), 10);
      await upsertOrder(env, interaction, eventId, raw.slice(sep + 1), price);
      return updated(env, eventId);
    }

    case "cancel":
      await env.DB.prepare("delete from bento_orders where id = ? and event_id = ?")
        .bind(interaction.data.values[0], eventId)
        .run();
      return updated(env, eventId);

    case "pay":
      await env.DB.prepare(
        "update bento_orders set paid = 1 where event_id = ? and discord_user_id = ?",
      )
        .bind(eventId, userId(interaction))
        .run();
      return updated(env, eventId);

    case "unpay":
      await env.DB.prepare("update bento_orders set paid = 0 where id = ? and event_id = ?")
        .bind(interaction.data.values[0], eventId)
        .run();
      return updated(env, eventId);

    default:
      return reply("不明な操作です。");
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
async function handleModal(interaction: any, env: Env, ctx: ExecutionContext) {
  const [action, eventId] = interaction.data.custom_id.split(":");

  if (action === "newitem") {
    const name = modalValue(interaction, "item_name");
    // 金額の上限は決めない。表に出るので人間が気づく（合意メモ）
    const price = Number.parseInt(modalValue(interaction, "price").replace(/[^0-9]/g, ""), 10);
    if (!name || Number.isNaN(price)) return reply("品名と金額（数字）を入れてください。");
    await upsertOrder(env, interaction, eventId, name, price);
    return updated(env, eventId);
  }

  if (action === "doclose") {
    const shared: SharedCost[] = [];
    for (const line of modalValue(interaction, "shared").split("\n")) {
      const m = line.trim().match(/^(.*?)[\s　]+([0-9,]+)$/);
      if (m) shared.push({ label: m[1], amount: Number.parseInt(m[2].replace(/,/g, ""), 10) });
    }
    await env.DB.prepare("update bento_events set status = 'closed', shared_costs = ? where id = ?")
      .bind(JSON.stringify(shared), eventId)
      .run();

    const res = await updated(env, eventId);
    // 締め切りだけは1回だけ通知する。以降の未払いの催促は表示のみで通知しない
    ctx.waitUntil(
      discord(`/channels/${interaction.channel_id}/messages`, env.DISCORD_BOT_TOKEN, {
        method: "POST",
        body: JSON.stringify({ content: "@here 注文を締め切りました。集金をお願いします。" }),
      }).catch(() => {}),
    );
    return res;
  }

  return reply("不明な操作です。");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("ok");

    // 生ボディが要る。先に req.json() すると署名検証ができなくなる
    const rawBody = await req.text();
    if (!(await verifySignature(req, rawBody, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody);

    switch (interaction.type) {
      case PING:
        return json({ type: PONG });
      case APPLICATION_COMMAND:
        return createEvent(interaction, env, ctx);
      case MESSAGE_COMPONENT:
        return handleComponent(interaction, env);
      case MODAL_SUBMIT:
        return handleModal(interaction, env, ctx);
      default:
        return new Response("unknown interaction type", { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
