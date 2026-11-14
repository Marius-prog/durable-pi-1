import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.ts";
import { withEnv } from "./helpers.ts";
import { Jev, type Question } from "../apps/proactive-dpi-be/src/jev.ts";

const QUESTIONS: Record<string, Question> = {
  verdict: { type: "choice", instructions: "Judge it", criteria: { normal: "fine", incident: "broken" } },
  impact: { type: "score", instructions: "How bad", criteria: ["none", "some"] },
};

const goodBody = (extra: Record<string, unknown> = {}) => ({
  model: "typesafe/jev-latest",
  answers: {
    verdict: { type: "choice", choice: "incident", probabilities: { normal: 0.1, incident: 0.9 }, confidence: 0.8 },
    impact: { type: "score", score: 3, probabilities: { "3": 1 }, confidence: 0.7 },
  },
  usage: { cost: 0.00003 },
  ...extra,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let restoreEnv: () => void;
let calls: { url: string; init: RequestInit }[];
let responses: (() => Response | Promise<Response>)[];
let fetchMock: ReturnType<typeof mock.method>;

beforeEach(() => {
  restoreEnv = withEnv({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: undefined });
  calls = [];
  responses = [];
  fetchMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw Error("unexpected extra fetch");
    return next();
  });
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  mock.timers.reset();
  fetchMock.mock.restore();
  restoreEnv();
});

/** Resolves `promise`, ticking the mocked setTimeout so retry backoff does not take real time. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  while (!done) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(2000);
  }
  return promise;
}

test("constructor: TypeSafe key goes straight to TypeSafe", () => {
  const jev = new Jev();
  assert.equal(jev.provider, "typesafe");
});

test("constructor: OpenRouter key alone uses the OpenRouter decisions endpoint", async () => {
  restoreEnv();
  restoreEnv = withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: "or-key" });
  const jev = new Jev();
  assert.equal(jev.provider, "openrouter");
  responses.push(() => json(goodBody()));
  await jev.ask({ x: 1 }, QUESTIONS);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer or-key");
  assert.equal(JSON.parse(String(calls[0].init.body)).model, "~typesafe/jev-latest");
});

test("constructor: TypeSafe wins when both keys are set; neither key throws", () => {
  restoreEnv();
  restoreEnv = withEnv({ TYPESAFE_API_KEY: "a", OPENROUTER_API_KEY: "b" });
  assert.equal(new Jev().provider, "typesafe");
  restoreEnv();
  restoreEnv = withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
  assert.throws(() => new Jev(), /Jev needs TYPESAFE_API_KEY or OPENROUTER_API_KEY/);
  restoreEnv();
  restoreEnv = withEnv({ TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "" });
  assert.throws(() => new Jev(), /Jev needs/, "empty strings are not keys");
});

test("ask: posts model, state and questions to TypeSafe with the bearer key, and refuses redirects", async () => {
  responses.push(() => json(goodBody()));
  await new Jev().ask({ severity: "ERROR", message: "boom" }, QUESTIONS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer ts-key", "Content-Type": "application/json" });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call has a timeout");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: "jev-latest",
    state: { severity: "ERROR", message: "boom" },
    questions: QUESTIONS,
  });
});

test("ask: returns the model, both answers, the cost and a latency", async () => {
  responses.push(() => json(goodBody()));
  const result = await new Jev().ask({}, QUESTIONS);
  assert.equal(result.model, "typesafe/jev-latest");
  assert.equal(result.cost, 0.00003);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(result.answers.verdict.type, "choice");
  assert.equal((result.answers.impact as { score: number }).score, 3);
});

test("ask: cost is null unless usage.cost is a non-negative number", async () => {
  const costOf = async (usage: unknown) => {
    responses.push(() => json(goodBody({ usage })));
    return (await new Jev().ask({}, QUESTIONS)).cost;
  };
  assert.equal(await costOf({ cost: 0 }), 0);
  assert.equal(await costOf({ cost: -1 }), null);
  assert.equal(await costOf({ cost: "0.1" }), null);
  assert.equal(await costOf({}), null);
  assert.equal(await costOf(undefined), null);
});

test("ask: an answer that is missing or has the wrong type is an error", async () => {
  const bodyWithout = (id: string) => {
    const body = goodBody();
    delete (body.answers as Record<string, unknown>)[id];
    return body;
  };
  responses.push(() => json(bodyWithout("impact")));
  await assert.rejects(() => new Jev().ask({}, QUESTIONS), /Jev answer missing: impact/);
  const wrongType = goodBody();
  (wrongType.answers.verdict as { type: string }).type = "score";
  responses.push(() => json(wrongType));
  await assert.rejects(() => new Jev().ask({}, QUESTIONS), /Jev answer missing: verdict/);
  responses.push(() => json({ model: "m" }));
  await assert.rejects(() => new Jev().ask({}, QUESTIONS), /Jev answer missing: verdict/);
});

for (const status of [429, 502, 503, 529]) {
  test(`ask: retries a ${status} and succeeds on the next answer`, async () => {
    responses.push(() => new Response("busy", { status }), () => json(goodBody()));
    const result = await drive(new Jev().ask({}, QUESTIONS));
    assert.equal(calls.length, 2);
    assert.equal(result.cost, 0.00003);
    assert.equal(calls[1].init.body, calls[0].init.body, "the retry sends the same request");
  });
}

test("ask: backs off 800ms, then 1600ms, between attempts", async () => {
  responses.push(() => new Response("", { status: 503 }), () => new Response("", { status: 503 }), () => json(goodBody()));
  const promise = new Jev().ask({}, QUESTIONS);
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  assert.equal(calls.length, 1);
  mock.timers.tick(799);
  await settle();
  assert.equal(calls.length, 1, "still waiting at 799ms");
  mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 2, "second attempt at 800ms");
  mock.timers.tick(1599);
  await settle();
  assert.equal(calls.length, 2, "still waiting at 1599ms");
  mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 3, "third attempt at 1600ms");
  assert.equal((await promise).model, "typesafe/jev-latest");
});

test("ask: gives up after 3 attempts and reports the last status", async () => {
  for (let i = 0; i < 5; i++) responses.push(() => new Response("", { status: 429 }));
  await assert.rejects(() => drive(new Jev().ask({}, QUESTIONS)), /Jev HTTP 429/);
  assert.equal(calls.length, 3);
});

test("ask: a retry that ends in a hard error reports that error", async () => {
  responses.push(() => new Response("", { status: 502 }), () => new Response("", { status: 401 }));
  await assert.rejects(() => drive(new Jev().ask({}, QUESTIONS)), /Jev HTTP 401/);
  assert.equal(calls.length, 2);
});

for (const status of [400, 401, 403, 404, 422, 500, 504]) {
  test(`ask: ${status} is not retried`, async () => {
    responses.push(() => new Response("nope", { status }));
    await assert.rejects(() => new Jev().ask({}, QUESTIONS), new RegExp(`Jev HTTP ${status}$`));
    assert.equal(calls.length, 1);
  });
}

test("ask: a network failure or timeout rejects at once without retrying", async () => {
  responses.push(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(() => new Jev().ask({}, QUESTIONS), /fetch failed/);
  assert.equal(calls.length, 1);
});

test("ask: a 200 with a body that is not JSON rejects", async () => {
  responses.push(() => new Response("<html>gateway</html>", { status: 200 }));
  await assert.rejects(() => new Jev().ask({}, QUESTIONS), SyntaxError);
});

test("ask: answers are only checked for the questions asked", async () => {
  responses.push(() => json(goodBody()));
  const result = await new Jev().ask({}, { verdict: QUESTIONS.verdict });
  assert.deepEqual(Object.keys(result.answers).sort(), ["impact", "verdict"], "extra answers pass through");
});
