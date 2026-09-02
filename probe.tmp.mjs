import { generateKeyPairSync, sign } from "node:crypto";

const mod = await import("./src/index.ts");
const worker = mod.default;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const env = { DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_BOT_TOKEN: "dummy" };
const ctx = { waitUntil() {}, passThroughOnException() {} };

function signed(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
}

const post = (body, headers) =>
  worker.fetch(new Request("http://x/", { method: "POST", headers, body }), env, ctx);

let ok = true;
const check = (name, cond, extra = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${extra}`);
};

{
  const body = JSON.stringify({ type: 1 });
  const res = await post(body, signed(body));
  check("AC-1 PING -> 200 {type:1}", res.status === 200, JSON.stringify(await res.clone().json()));
}
{
  const body = JSON.stringify({ type: 1 });
  const h = signed(body);
  h["x-signature-ed25519"] = "00".repeat(64);
  const res = await post(body, h);
  check("AC-2 bad signature -> 401", res.status === 401, String(res.status));
}
{
  const body = JSON.stringify({ type: 1 });
  const res = await post(body, { "content-type": "application/json" });
  check("AC-2 missing headers -> 401", res.status === 401, String(res.status));
}
{
  const res = await post(JSON.stringify({ type: 2 }), signed(JSON.stringify({ type: 1 })));
  check("AC-3 tampered body -> 401", res.status === 401, String(res.status));
}
{
  const body = '{ "type" : 1 }';
  const res = await post(body, signed(body));
  const j = res.status === 200 ? await res.json() : null;
  check("AC-3 whitespace body -> 200", res.status === 200 && j?.type === 1, String(res.status));
}
{
  const res = await worker.fetch(new Request("http://x/", { method: "GET" }), env, ctx);
  check("AC-4 GET -> 405", res.status === 405, String(res.status));
}
{
  const res = await post("not json at all", { "content-type": "application/json" });
  check("AC-2 no parse on bad sig", res.status === 401, String(res.status));
}

process.exit(ok ? 0 : 1);
