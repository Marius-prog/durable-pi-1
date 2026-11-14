// jev.ts with a stubbed fetch: no network, no real keys.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { askJev, type JevAnswer, type JevQuestion } from "../src/jev.js";

const QUESTIONS: Record<string, JevQuestion> = {
  effect: { type: "choice", instructions: "What does it do?", criteria: { read_only: "reads", irreversible: "wipes" } },
  intent: { type: "noul", instructions: "Destructive?" },
};
const ANSWERS: Record<string, JevAnswer> = {
  effect: { type: "choice", choice: "read_only", confidence: 0.9, probabilities: { read_only: 0.9, irreversible: 0.1 } },
  intent: { type: "noul", noul: 0.05 },
};

type Seen = { url: string; init: RequestInit };
const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("askJev", () => {
  const realFetch = globalThis.fetch;
  const keys = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  let seen: Seen[];
  let script: (call: number) => Response | Promise<Response>;

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    seen = [];
    script = () => reply(200, { answers: ANSWERS });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return script(seen.length);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const body = (i = 0) => JSON.parse(String(seen[i].init.body)) as Record<string, unknown>;
  const auth = (i = 0) => (seen[i].init.headers as Record<string, string>).Authorization;

  test("without any key it refuses before making a request", async () => {
    await assert.rejects(() => askJev({ command: "ls" }, QUESTIONS), /Jev needs TYPESAFE_API_KEY or OPENROUTER_API_KEY/);
    assert.equal(seen.length, 0);
  });

  test("a TypeSafe key calls the System One endpoint with model jev-latest", async () => {
    process.env.TYPESAFE_API_KEY = "ts-fake-key";
    const answers = await askJev({ command: "ls" }, QUESTIONS);
    assert.deepEqual(answers, ANSWERS);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(auth(), "Bearer ts-fake-key");
    assert.equal((seen[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.deepEqual(body(), { model: "jev-latest", state: { command: "ls" }, questions: QUESTIONS });
  });

  test("an OpenRouter key alone calls the OpenRouter decisions endpoint", async () => {
    process.env.OPENROUTER_API_KEY = "or-fake-key";
    await askJev({ command: "ls" }, QUESTIONS);
    assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(auth(), "Bearer or-fake-key");
    assert.equal(body().model, "~typesafe/jev-latest");
  });

  test("the TypeSafe key wins when both are set", async () => {
    process.env.TYPESAFE_API_KEY = "ts-fake-key";
    process.env.OPENROUTER_API_KEY = "or-fake-key";
    await askJev({}, QUESTIONS);
    assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(auth(), "Bearer ts-fake-key");
  });

  test("an empty key counts as no key", async () => {
    process.env.TYPESAFE_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "or-fake-key";
    await askJev({}, QUESTIONS);
    assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
  });

  test("requests never follow redirects and always carry a timeout signal", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    await askJev({}, QUESTIONS);
    assert.equal(seen[0].init.redirect, "error");
    assert.ok(seen[0].init.signal instanceof AbortSignal);
    assert.equal(seen[0].init.signal.aborted, false);
  });

  test("a caller's abort signal reaches the request", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const controller = new AbortController();
    script = () => reply(200, { answers: ANSWERS });
    await askJev({}, QUESTIONS, controller.signal);
    const signal = seen[0].init.signal as AbortSignal;
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
  });

  test("a non-retryable HTTP error throws once, with the status, and does not retry", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    for (const status of [400, 401, 403, 404, 500]) {
      seen.length = 0;
      script = () => reply(status, { error: "no" });
      await assert.rejects(() => askJev({}, QUESTIONS), new RegExp(`^Error: Jev HTTP ${status}$`));
      assert.equal(seen.length, 1, `status ${status}`);
    }
  });

  test("a throttled or overloaded answer is retried, then succeeds", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = (n) => (n === 1 ? reply(429, "slow down") : reply(200, { answers: ANSWERS }));
    const started = Date.now();
    assert.deepEqual(await askJev({}, QUESTIONS), ANSWERS);
    assert.equal(seen.length, 2);
    assert.ok(Date.now() - started >= 700, "backed off before the retry");
  });

  test("502 and 529 are retryable too", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    for (const status of [502, 529]) {
      seen.length = 0;
      script = (n) => (n === 1 ? reply(status, "later") : reply(200, { answers: ANSWERS }));
      assert.deepEqual(await askJev({}, QUESTIONS), ANSWERS, `status ${status}`);
      assert.equal(seen.length, 2);
    }
  });

  test("it gives up after three attempts on a persistent 503", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = () => reply(503, "down");
    await assert.rejects(() => askJev({}, QUESTIONS), /Jev HTTP 503/);
    assert.equal(seen.length, 3);
  });

  test("a network failure propagates as the fetch error", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(() => askJev({}, QUESTIONS), /fetch failed/);
  });

  test("every asked question must be answered with the matching type", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = () => reply(200, { answers: { effect: ANSWERS.effect } });
    await assert.rejects(() => askJev({}, QUESTIONS), /Jev answer missing: intent/);
    script = () => reply(200, { answers: { effect: ANSWERS.intent, intent: ANSWERS.intent } });
    await assert.rejects(() => askJev({}, QUESTIONS), /Jev answer missing: effect/);
    script = () => reply(200, {});
    await assert.rejects(() => askJev({}, QUESTIONS), /Jev answer missing/);
  });

  test("extra answers the caller did not ask for are passed through", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = () => reply(200, { answers: { ...ANSWERS, bonus: { type: "noul", noul: 1 } } });
    const answers = await askJev({}, QUESTIONS);
    assert.deepEqual(Object.keys(answers).sort(), ["bonus", "effect", "intent"]);
  });

  test("a body that is not JSON rejects", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    script = () => reply(200, "<html>not json</html>");
    await assert.rejects(() => askJev({}, QUESTIONS));
  });
});
