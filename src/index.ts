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
  /** 締め切るときに幹事が入れる送金先。PayPayのリンクでも電話番号でも口座でもいい */
  payment_info: string | null;
  /** 締め切りを知らせた @here のメッセージ。再開したときに書き換える先 */
  notice_message_id: string | null;
  /** 締め切った人＝立て替えた人の表示名。頼むだけで食べない幹事もいるので注文からは引けない */
  closed_by: string | null;
};

type BentoOrder = {
  id: string;
  event_id: string;
  discord_user_id: string;
  display_name: string;
  item_name: string;
  price: number;
  paid: number;
  /** 代わりに入力した人の表示名。null なら本人が自分で入れた */
  ordered_by: string | null;
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

  // Ed25519 の署名は64バイト固定。長さや16進が壊れていると verify は false ではなく
  // 例外を投げる。公開エンドポイントなのでゴミも飛んでくる。落として500にせず401に寄せる
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
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

/** 「１,０００円」のような全角・記号混じりから数字だけ取り出す。IME の全角入力で落ちないように */
function toNumber(s: string) {
  return Number.parseInt(s.normalize("NFKC").replace(/[^0-9]/g, ""), 10);
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
function render(ev: BentoEvent, orders: BentoOrder[]) {
  const shared: SharedCost[] = JSON.parse(ev.shared_costs);
  const sharedTotal = shared.reduce((s, c) => s + c.amount, 0);
  // 端数は切り上げ。余りは幹事が飲む（合意メモの通り）
  const perHead = orders.length > 0 ? Math.ceil(sharedTotal / orders.length) : 0;
  const closed = ev.status === "closed";

  const lines = [`## ${ev.title}`];
  if (ev.menu_url) lines.push(`メニュー: ${ev.menu_url}`);
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
    const names = list
      .map((x) =>
        x.ordered_by ? `${x.display_name}（${x.ordered_by}が代理入力）` : x.display_name,
      )
      .join(", ");
    lines.push(`- ${o.item_name}  ${amount}  ×${list.length}  ${names}`);
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
    const payer = ev.closed_by ? `（立て替え: ${ev.closed_by}）` : "";
    lines.push(`**集金** ${orders.length - unpaid.length}/${orders.length}${payer}`);
    if (unpaid.length > 0) lines.push(`未払い: ${unpaid.map((o) => o.display_name).join(", ")}`);
    // 送金先は口座番号のように複数行のこともあるので、1行に押し込めず改行のまま出す
    if (ev.payment_info) lines.push("", "**支払先**", ev.payment_info);
  }

  // Discord のメッセージは2000文字まで。超えると差し替えが 400 で弾かれ、
  // 押した人には「この操作に失敗しました」としか出ない。溢れたと分かる形で切る
  const out = lines.join("\n");
  if (out.length <= 2000) return out;
  return `${out.slice(0, 1900)}\n…（長くなりすぎたので省略しました）`;
}

/**
 * 既出の品がそのままメニューになる。メニュー用のテーブルは持たない。
 * 自分の分（頼む）と代理入力の両方から同じ一覧を出すのでここにまとめる
 */
function menuOptions(orders: BentoOrder[]) {
  const menu = new Map<string, BentoOrder>();
  for (const o of orders) menu.set(`${o.item_name} ${o.price}`, o);
  return [...menu.values()].slice(0, 25).map((o) => ({
    label: `${o.item_name} ${yen(o.price)}`.slice(0, 100),
    value: `${o.price}:${o.item_name}`.slice(0, 100),
  }));
}

/**
 * ponytail: セレクトの選択肢は Discord の上限で25件まで。26人目からは
 * 一覧に出ないので「取り消す」から選べない（注文は「新しく入力」でできる）。
 * 26人以上で回すことになったら、ページ送りか名前での絞り込みを足す。
 */
function components(ev: BentoEvent, orders: BentoOrder[]) {
  const rows: unknown[] = [];

  if (ev.status === "open") {
    const menu = menuOptions(orders);

    if (menu.length > 0) {
      rows.push({
        type: 1,
        components: [{ type: 3, custom_id: `pick:${ev.id}`, placeholder: "頼む", options: menu }],
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

    // type 5 はユーザーセレクト。選択肢はサーバーの参加者から Discord が出す。
    // 選んだ相手は次の MODAL の custom_id に載せて運ぶ
    rows.push({
      type: 1,
      components: [
        {
          type: 5,
          custom_id: `proxy:${ev.id}`,
          placeholder: "代わりに入力する（後から来る人の分）",
        },
      ],
    });

    rows.push({
      type: 1,
      components: [
        { type: 2, style: 1, label: "新しく入力", custom_id: `new:${ev.id}` },
        // 未設定のときは「貼る」と出して、メニューを付けられること自体を知らせる
        {
          type: 2,
          style: 2,
          label: ev.menu_url ? "メニューを変える" : "メニューを貼る",
          custom_id: `menu:${ev.id}`,
        },
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

    // 締め切りは押し間違えると詰む操作なので、開き直す出口を必ず残す
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, label: "支払った", custom_id: `pay:${ev.id}` },
        { type: 2, style: 2, label: "再開", custom_id: `reopen:${ev.id}` },
      ],
    });
  }

  return rows;
}

/**
 * DB を引いて集計メッセージを組み立てる。ボタンを押すたびに毎回これを通る。
 *
 * 書き込みは writes に渡す。読み直しと同じ batch に入れて1往復で済ませるため。
 * Worker は Discord のリクエスト元（米国）で動くのに D1 の primary は
 * データベースを作った場所（日本）にあるので、1往復ごとに 200ms 近く乗る。
 * Discord は3秒で切るので、素直に「書く→読む→読む」と3往復すると余裕が無い。
 */
async function board(env: Env, eventId: string, ...writes: D1PreparedStatement[]) {
  const rows = await env.DB.batch([
    ...writes,
    env.DB.prepare("select * from bento_events where id = ?").bind(eventId),
    env.DB.prepare("select * from bento_orders where event_id = ? order by created_at").bind(
      eventId,
    ),
  ]);

  const ev = rows[rows.length - 2].results[0] as BentoEvent | undefined;
  if (!ev) return null;
  const orders = rows[rows.length - 1].results as unknown as BentoOrder[];

  return {
    ev,
    orders,
    // 何行変わったかは、押した人に返す文言を決めるのに使う（0件なら空振り）
    writes: rows.slice(0, writes.length),
    data: {
      content: render(ev, orders),
      components: components(ev, orders),
      // 品名・表示名・支払先はそのまま本文に載る。@everyone と書かれても
      // メンションとして解釈させない。表示は文字列のまま変わらない
      allowed_mentions: { parse: [] },
    },
  };
}

/** 押した先のイベントがもう無いとき。押した本人にだけ返す */
function gone() {
  return reply("この募集はもうありません。");
}

/**
 * 更新後の集計メッセージで、押された元メッセージをそのまま差し替える。
 *
 * ponytail: 2人がほぼ同時に押すと、後から届いたほうの差し替えが古い盤面で
 * 上書きすることがある。DB は正しいままで、次に誰かが押せば直る。
 * 直すなら集計メッセージに版番号を持たせて条件付き更新にするが、
 * ずれるのが表示だけで自然に治る以上、割に合わない。
 */
async function updated(env: Env, eventId: string, ...writes: D1PreparedStatement[]) {
  const b = await board(env, eventId, ...writes);
  if (!b) return gone();
  return json({ type: UPDATE_MESSAGE, data: b.data });
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
        { method: "POST", body: JSON.stringify((await board(env, eventId))?.data) },
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

/**
 * メニューURLの入力欄。/bento の任意引数は Discord の UI では気づかれにくいので、
 * 集計メッセージのボタンからも貼れるようにしてある。
 */
function menuModal(eventId: string, current: string | null) {
  return json({
    type: MODAL,
    data: {
      custom_id: `domenu:${eventId}`,
      title: "メニューのリンク",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "menu_url",
              label: "URL",
              style: 1,
              placeholder: "https://example.com/menu.pdf",
              max_length: 400,
              // 空で送ると消せる。貼り間違えたときに直せないと困る
              required: false,
              value: current ?? undefined,
            },
          ],
        },
      ],
    },
  });
}

/**
 * 品名と金額の入力欄。custom_id に event_id を載せて次の MODAL_SUBMIT まで運ぶ。
 *
 * 代理入力のときは相手の user_id も載せる。MODAL_SUBMIT には選んだ相手の情報が
 * 付いてこないので、表示名は初期値付きの入力欄に入れて一緒に戻ってくるようにする
 * （Discord に問い合わせ直さずに済むし、押した人は誰の分か見て確かめられる）。
 */
function itemModal(
  eventId: string,
  target?: { id: string; name: string },
  // ephemeral から開いたモーダルは、送信の返事も ephemeral に向く。
  // 集計メッセージの差し替え方が変わるので、送信先を custom_id で分ける
  action: "newitem" | "pitem" = "newitem",
) {
  return json({
    type: MODAL,
    data: {
      custom_id: target ? `${action}:${eventId}:${target.id}` : `${action}:${eventId}`,
      title: target ? "代わりに入力" : "注文を入力",
      components: [
        ...(target
          ? [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "for_name",
                    label: "誰の分",
                    style: 1,
                    max_length: 32,
                    value: target.name,
                    required: true,
                  },
                ],
              },
            ]
          : []),
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

/**
 * 締め切りの入力欄。割り勘する費用と、集金の送金先。
 * 送金先は前回の値を初期値に入れておくので、幹事が同じなら触らず閉じるだけで済む。
 */
function closeModal(eventId: string, lastPaymentInfo: string | null) {
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
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "payment",
              label: "支払先",
              style: 2,
              // 何を書けばいいのかはここで示す。形式は問わない
              placeholder:
                "PayPay 090-1234-5678\nPayPayリンク https://pay.paypay.ne.jp/xxxxxxxx\n〇〇銀行 △△支店 普通 1234567 ヤマダタロウ",
              max_length: 400,
              required: false,
              value: lastPaymentInfo ?? undefined,
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

/**
 * 注文を1件入れる文。unique(event_id, discord_user_id) があるので2回目は上書きになる。
 * userId は「頼む本人」であって、押した人とは限らない（代理入力）。
 * 本人があとから自分で入れ直せば ordered_by も消えて、代理の跡が残らない。
 * 実行せずに文だけ返すのは、盤面の読み直しと同じ batch に入れるため。
 */
function orderStmt(
  env: Env,
  eventId: string,
  targetUserId: string,
  targetName: string,
  name: string,
  price: number,
  orderedBy: string | null,
) {
  return env.DB.prepare(
    `insert into bento_orders (id, event_id, discord_user_id, display_name, item_name, price, ordered_by)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(event_id, discord_user_id) do update set
       display_name = excluded.display_name,
       item_name = excluded.item_name,
       price = excluded.price,
       ordered_by = excluded.ordered_by`,
  ).bind(crypto.randomUUID(), eventId, targetUserId, targetName, name, price, orderedBy);
}

/**
 * 代理入力の ephemeral から注文を入れたときの後始末。
 * interaction の返事は ephemeral 自身に向くので、集計メッセージのほうは
 * bot として直接書き換えるしかない。押した本人には ephemeral で結果を返す
 */
async function fromEphemeral(
  env: Env,
  ctx: ExecutionContext,
  eventId: string,
  name: string,
  ...writes: D1PreparedStatement[]
) {
  const b = await board(env, eventId, ...writes);
  if (!b) return gone();
  if (b.ev.message_id) {
    ctx.waitUntil(
      discord(`/channels/${b.ev.channel_id}/messages/${b.ev.message_id}`, env.DISCORD_BOT_TOKEN, {
        method: "PATCH",
        body: JSON.stringify(b.data),
      }).catch(() => {}),
    );
  }
  // 選び終わったボタンを残すと二度押しできてしまうので、components ごと消す
  return json({
    type: UPDATE_MESSAGE,
    data: { content: `${name} の分を入れました。`, components: [] },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
async function handleComponent(interaction: any, env: Env, ctx: ExecutionContext) {
  // 代理入力の ephemeral だけは、誰の分かを custom_id に載せて運ぶ。
  // 表示名にコロンが入っていても壊れないよう、名前は残り全部として読む
  const parts: string[] = interaction.data.custom_id.split(":");
  const [action, eventId] = parts;
  const targetId = parts[2];
  const targetName = parts.slice(3).join(":");

  // 状態と、締め切りモーダルの初期値を1回で引く。
  // last_payment は「このイベントの支払先、無ければ同じサーバーで最後に使った支払先」
  // 支払先は他のイベントから引き継がない。引き継ぐと、用の済んだ送金先が
  // サーバー単位でいつまでも残ってしまう
  const ev = await env.DB.prepare(
    "select status, menu_url, payment_info, notice_message_id from bento_events where id = ?",
  )
    .bind(eventId)
    .first<{
      status: "open" | "closed";
      menu_url: string | null;
      payment_info: string | null;
      notice_message_id: string | null;
    }>();
  if (!ev) return gone();

  // 集計メッセージが古いまま押されることがある。締め切り済みに注文を入れさせない、
  // 締め切り前に集金を触らせない。ボタンの見た目ではなく DB の状態で決める
  const whileOpen =
    action === "new" ||
    action === "proxy" ||
    action === "pick" ||
    action === "cancel" ||
    action === "menu" ||
    action === "ppick" ||
    action === "pnew";
  if ((whileOpen || action === "close") && ev.status === "closed") {
    return reply("この募集はもう締め切られています。");
  }
  if (!whileOpen && action !== "close" && ev.status === "open") {
    return reply("この募集はまだ開いています。");
  }

  switch (action) {
    case "new":
      return itemModal(eventId);

    case "proxy": {
      // ユーザーセレクトの選択結果。表示名は resolved に付いてくる
      const id: string = interaction.data.values[0];
      const r = interaction.data.resolved;
      const name = (
        r?.members?.[id]?.nick ||
        r?.users?.[id]?.global_name ||
        r?.users?.[id]?.username ||
        "?"
      ).slice(0, 32); // custom_id は100文字まで。uuid と user_id で67文字使う

      const b = await board(env, eventId);
      if (!b) return gone();
      const menu = menuOptions(b.orders);
      // まだ1件も入っていないなら選ぶものが無い。そのまま入力してもらう
      if (menu.length === 0) return itemModal(eventId, { id, name });

      // 自分の分と同じで、既出の品はメニューから選べたほうが速い。
      // モーダルにセレクトは入れられないので、いったん本人にだけ見える形で出す
      return json({
        type: CHANNEL_MESSAGE,
        data: {
          content: `${name} の分を入れます。`,
          flags: EPHEMERAL,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: `ppick:${eventId}:${id}:${name}`,
                  placeholder: "メニューから選ぶ",
                  options: menu,
                },
              ],
            },
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "メニューに無いものを入力",
                  custom_id: `pnew:${eventId}:${id}:${name}`,
                },
              ],
            },
          ],
        },
      });
    }

    case "pnew":
      return itemModal(eventId, { id: targetId, name: targetName }, "pitem");

    case "ppick": {
      const raw: string = interaction.data.values[0];
      const sep = raw.indexOf(":");
      return fromEphemeral(
        env,
        ctx,
        eventId,
        targetName,
        orderStmt(
          env,
          eventId,
          targetId,
          targetName,
          raw.slice(sep + 1),
          Number.parseInt(raw.slice(0, sep), 10),
          // 自分を選んだときは代理扱いにしない
          targetId === userId(interaction) ? null : displayName(interaction),
        ),
      );
    }

    case "close":
      return closeModal(eventId, ev.payment_info);

    case "menu":
      return menuModal(eventId, ev.menu_url);

    case "reopen":
      // 「締め切りました」を残すと、あとから見た人は締め切られたと思う。
      // 通知を増やさず、同じ1本を書き換える。消えるより経緯が残るほうがいい
      if (ev.notice_message_id) {
        ctx.waitUntil(
          discord(
            `/channels/${interaction.channel_id}/messages/${ev.notice_message_id}`,
            env.DISCORD_BOT_TOKEN,
            {
              method: "PATCH",
              body: JSON.stringify({ content: "締め切りを取り消しました。まだ入れられます。" }),
            },
          ).catch(() => {}),
        );
      }
      return updated(
        env,
        eventId,
        env.DB.prepare(
          "update bento_events set status = 'open', notice_message_id = null where id = ?",
        ).bind(eventId),
      );

    case "pick": {
      // value は "650:唐揚げ弁当"。品名にコロンが入っても壊れないよう最初の1個で切る
      const raw: string = interaction.data.values[0];
      const sep = raw.indexOf(":");
      const price = Number.parseInt(raw.slice(0, sep), 10);
      return updated(
        env,
        eventId,
        orderStmt(
          env,
          eventId,
          userId(interaction),
          displayName(interaction),
          raw.slice(sep + 1),
          price,
          null,
        ),
      );
    }

    case "cancel":
      return updated(
        env,
        eventId,
        env.DB.prepare("delete from bento_orders where id = ? and event_id = ?").bind(
          interaction.data.values[0],
          eventId,
        ),
      );

    case "pay": {
      const b = await board(
        env,
        eventId,
        env.DB.prepare(
          "update bento_orders set paid = 1 where event_id = ? and discord_user_id = ?",
        ).bind(eventId, userId(interaction)),
      );
      if (!b) return gone();
      // 頼んでいない人が押すと0件。何も変わらないと壊れて見えるので本人に返す
      if (b.writes[0].meta.changes === 0) return reply("あなたの注文が見つかりません。");
      return json({ type: UPDATE_MESSAGE, data: b.data });
    }

    case "unpay":
      return updated(
        env,
        eventId,
        env.DB.prepare("update bento_orders set paid = 0 where id = ? and event_id = ?").bind(
          interaction.data.values[0],
          eventId,
        ),
      );

    default:
      return reply("不明な操作です。");
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Discord の interaction は形が type ごとに変わる
async function handleModal(interaction: any, env: Env, ctx: ExecutionContext) {
  const [action, eventId, targetId] = interaction.data.custom_id.split(":");

  // モーダルは開いたまま放置できる。送信されたときには締め切り済みかもしれない
  const ev = await env.DB.prepare("select status from bento_events where id = ?")
    .bind(eventId)
    .first<{ status: "open" | "closed" }>();
  if (!ev) return gone();
  if (ev.status === "closed") return reply("この募集はもう締め切られています。");

  // pitem は代理入力の ephemeral から開いたモーダル。入れるものは同じで、
  // 集計メッセージの差し替え方だけが違う
  if (action === "newitem" || action === "pitem") {
    const name = modalValue(interaction, "item_name");
    // 金額の上限は決めない。表に出るので人間が気づく（合意メモ）
    const price = toNumber(modalValue(interaction, "price"));
    if (!name || Number.isNaN(price)) return reply("品名と金額（数字）を入れてください。");
    // 代理入力なら custom_id に相手の user_id が載っている。自分を選んだときは
    // 代理扱いにしない
    const self = userId(interaction);
    const proxied = targetId !== undefined && targetId !== self;
    const forName = proxied
      ? modalValue(interaction, "for_name") || "unknown"
      : displayName(interaction);
    const stmt = orderStmt(
      env,
      eventId,
      proxied ? targetId : self,
      forName,
      name,
      price,
      proxied ? displayName(interaction) : null,
    );
    if (action === "pitem") return fromEphemeral(env, ctx, eventId, forName, stmt);
    return updated(env, eventId, stmt);
  }

  if (action === "domenu") {
    const url = modalValue(interaction, "menu_url").trim();
    // 空なら消す。https:// を付け忘れると Discord がリンクにしないので補う
    const normalized = url === "" ? null : /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return updated(
      env,
      eventId,
      env.DB.prepare("update bento_events set menu_url = ? where id = ? and status = 'open'").bind(
        normalized,
        eventId,
      ),
    );
  }

  if (action === "doclose") {
    const shared: SharedCost[] = [];
    for (const raw of modalValue(interaction, "shared").split("\n")) {
      // IME の全角混じり（「配送料　５００」）でも拾えるよう半角に寄せてから読む
      const m = raw
        .normalize("NFKC")
        .trim()
        .match(/^(.*?)\s+([0-9,]+)$/);
      if (m) shared.push({ label: m[1], amount: Number.parseInt(m[2].replace(/,/g, ""), 10) });
    }
    const payment = modalValue(interaction, "payment");

    // status を条件に入れて、二重に締め切っても2回目は何も起きないようにする。
    // 締め切り通知の @here を2回飛ばさないための条件でもある
    const b = await board(
      env,
      eventId,
      // 締め切った人は立て替える側なので、自分の注文があれば集金済みにしておく。
      // 頼んでいなければ0行で何も起きない。締め切りの update より前に置くのは、
      // あとに置くと status がもう closed になっていて exists が外れるから
      env.DB.prepare(
        `update bento_orders set paid = 1
         where event_id = ? and discord_user_id = ?
           and exists (select 1 from bento_events where id = ? and status = 'open')`,
      ).bind(eventId, userId(interaction), eventId),
      env.DB.prepare(
        "update bento_events set status = 'closed', shared_costs = ?, payment_info = ?, closed_by = ? where id = ? and status = 'open'",
      ).bind(JSON.stringify(shared), payment || null, displayName(interaction), eventId),
    );
    if (!b) return gone();
    if (b.writes[1].meta.changes === 0) return reply("この募集はもう締め切られています。");

    const res = json({ type: UPDATE_MESSAGE, data: b.data });
    // 締め切りだけは1回だけ通知する。以降の未払いの催促は表示のみで通知しない
    ctx.waitUntil(
      (async () => {
        const msg = (await discord(
          `/channels/${interaction.channel_id}/messages`,
          env.DISCORD_BOT_TOKEN,
          {
            method: "POST",
            body: JSON.stringify({ content: "@here 注文を締め切りました。集金をお願いします。" }),
          },
        )) as { id: string };
        // 再開のときに書き換える先。控え損ねても締め切り自体は成立している
        await env.DB.prepare("update bento_events set notice_message_id = ? where id = ?")
          .bind(msg.id, eventId)
          .run();
      })().catch(() => {}),
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
        return handleComponent(interaction, env, ctx);
      case MODAL_SUBMIT:
        return handleModal(interaction, env, ctx);
      default:
        return new Response("unknown interaction type", { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
