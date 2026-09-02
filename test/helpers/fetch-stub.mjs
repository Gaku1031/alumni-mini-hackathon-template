/**
 * globalThis.fetch を差し替えて、Discord API に投げた内容を記録する。
 * 実際に discord.com を叩かずに「何をどう呼んだか」を検証するための道具。
 *
 *   const stub = installFetchStub([{ body: { id: "1" } }]);
 *   ...
 *   stub.calls[0].method;  // "POST"
 *   stub.restore();
 */

/**
 * @param {Array<{status?: number, body?: unknown}>} responses
 *   呼ばれた順に返す応答。足りなくなったら最後のものを使い回す
 */
export function installFetchStub(responses = [{ body: {} }]) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    });
    const spec = responses[Math.min(calls.length - 1, responses.length - 1)];
    const status = spec.status ?? 200;
    return new Response(JSON.stringify(spec.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** ctx.waitUntil に渡された Promise を集めるだけの ExecutionContext もどき */
export function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(p) {
      pending.push(p);
    },
    passThroughOnException() {},
    /** waitUntil に載った処理が終わるまで待つ（テストの中で結果を見るため） */
    settle: () => Promise.all(pending),
  };
}
