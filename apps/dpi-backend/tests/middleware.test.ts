// auth.ts, errors.ts and idempotency.ts, each behind a real Express server on an ephemeral port.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { ErrorCode } from "../../dpi-sdk/src/api.js";
import { bearerAuth } from "../src/auth.js";
import { ApiFault, errorMiddleware, invalid, notFound } from "../src/errors.js";
import { idempotent } from "../src/idempotency.js";
import { tempStore } from "./helpers.js";

const listen = async (app: express.Express) => {
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
};

describe("bearerAuth", () => {
  const TOKEN = "k".repeat(40);
  let srv: Awaited<ReturnType<typeof listen>>;
  before(async () => {
    const app = express();
    app.use(bearerAuth(TOKEN));
    app.get("/", (_req, res) => res.json({ ok: true }));
    srv = await listen(app);
  });
  after(() => srv.close());

  const get = (headers: Record<string, string> = {}) => fetch(`${srv.base}/`, { headers });

  test("accepts the token as a Bearer credential", async () => {
    assert.equal((await get({ authorization: `Bearer ${TOKEN}` })).status, 200);
  });

  test("accepts the token in X-DPI-Token for proxies that strip Authorization", async () => {
    assert.equal((await get({ "x-dpi-token": TOKEN })).status, 200);
  });

  test("trims whitespace around the presented token", async () => {
    assert.equal((await get({ authorization: `Bearer   ${TOKEN}  ` })).status, 200);
    assert.equal((await get({ "x-dpi-token": `  ${TOKEN} ` })).status, 200);
  });

  test("rejects a missing, empty, wrong or truncated token with the error envelope and a challenge", async () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer" },
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
      { "x-dpi-token": "" },
      { "x-dpi-token": "wrong" },
    ];
    for (const headers of cases) {
      const res = await get(headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="dpi"');
      assert.deepEqual(await res.json(), { error: { code: "unauthorized", message: "Missing or invalid device token" } });
    }
  });

  test("a good token in the wrong scheme is not enough, but the fallback header still works beside it", async () => {
    assert.equal((await get({ authorization: `Basic ${TOKEN}` })).status, 401);
    assert.equal((await get({ authorization: "Basic abc", "x-dpi-token": TOKEN })).status, 200);
  });

  test("the Bearer header takes precedence over X-DPI-Token", async () => {
    assert.equal((await get({ authorization: "Bearer wrong", "x-dpi-token": TOKEN })).status, 401);
  });
});

describe("errorMiddleware", () => {
  let srv: Awaited<ReturnType<typeof listen>>;
  const logged: unknown[][] = [];
  const realError = console.error;
  before(async () => {
    console.error = (...args: unknown[]) => void logged.push(args);
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/echo", (req, res) => res.json(req.body));
    app.get("/fault/:code", (req) => {
      throw new ApiFault(req.params.code as ErrorCode, `fault ${req.params.code}`);
    });
    app.get("/busy", () => {
      throw new ConversationBusy(1 as never);
    });
    app.get("/message", (req) => {
      throw new Error(String(req.query.m));
    });
    app.get("/nonerror", () => {
      throw "just a string";
    });
    app.get("/async", async () => {
      throw invalid("from an async handler");
    });
    app.get("/partial", (_req, res, next) => {
      res.write("partial");
      next(new Error("boom after headers"));
    });
    app.use(errorMiddleware);
    srv = await listen(app);
  });
  after(async () => {
    console.error = realError;
    await srv.close();
  });

  const envelope = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${srv.base}${path}`, init);
    return { status: res.status, body: (await res.json()) as { error: { code: string; message: string } } };
  };

  test("each ApiFault code maps to its HTTP status", async () => {
    const expected: Record<ErrorCode, number> = {
      unauthorized: 401,
      not_found: 404,
      invalid: 400,
      busy: 409,
      conflict: 409,
      ambiguous: 409,
      unavailable: 503,
      internal: 500,
      offline: 503,
    };
    for (const [code, status] of Object.entries(expected)) {
      const r = await envelope(`/fault/${code}`);
      assert.equal(r.status, status, code);
      assert.deepEqual(r.body, { error: { code, message: `fault ${code}` } });
    }
  });

  test("invalid() and notFound() build faults with the right code", () => {
    assert.equal(invalid("x").status, 400);
    assert.equal(invalid("x").code, "invalid");
    assert.equal(notFound("x").status, 404);
    assert.equal(notFound("x").code, "not_found");
    assert.ok(invalid("x") instanceof Error);
  });

  test("async handler errors reach the middleware too", async () => {
    const r = await envelope("/async");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, "from an async handler");
  });

  test("ConversationBusy becomes 409 busy", async () => {
    const r = await envelope("/busy");
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "busy");
  });

  test("malformed JSON and oversized bodies are 400 invalid with plain messages", async () => {
    const bad = await envelope("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: { code: "invalid", message: "Body must be valid JSON" } });
    const big = await envelope("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(4000) }) });
    assert.equal(big.status, 400);
    assert.deepEqual(big.body, { error: { code: "invalid", message: "Body too large" } });
  });

  test("the App State edit-conflict message becomes 409 conflict", async () => {
    const r = await envelope(`/message?m=${encodeURIComponent("App State changed while you were editing. Load the latest JSON before saving.")}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "conflict");
  });

  test("validation messages from the state and compaction code become 400 invalid", async () => {
    const messages = [
      "Field does not exist: x",
      "Invalid JSON Pointer escape",
      "Use a JSON Pointer path, such as /counter",
      "Increment requires numbers",
      "The state root must be a JSON object. Use update to replace it.",
      "State path is required",
      "Parent must be an object or array",
      "Value must be valid JSON",
      "Reserved field name",
      "App State must be under 100,000 characters",
      "State is too deeply nested",
    ];
    for (const m of messages) {
      const r = await envelope(`/message?m=${encodeURIComponent(m)}`);
      assert.equal(r.status, 400, m);
      assert.equal(r.body.error.code, "invalid", m);
      assert.equal(r.body.error.message, m);
    }
  });

  test("any other error is a 500 internal that carries its message and is logged once", async () => {
    logged.length = 0;
    const r = await envelope("/message?m=disk%20on%20fire");
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: { code: "internal", message: "disk on fire" } });
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /GET \/message:/);
    // Matching is anchored at the start: a validation word later in the message does not downgrade it.
    assert.equal((await envelope("/message?m=" + encodeURIComponent("oops: Field does not exist"))).status, 500);
  });

  test("a thrown non-Error is a generic 500", async () => {
    const r = await envelope("/nonerror");
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: { code: "internal", message: "Internal error" } });
  });

  test("an error after the response started ends the response instead of sending an envelope", async () => {
    const res = await fetch(`${srv.base}/partial`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "partial");
  });
});

describe("idempotent", () => {
  let t: Awaited<ReturnType<typeof tempStore>>;
  let store: Awaited<ReturnType<Awaited<ReturnType<typeof tempStore>>["open"]>>;
  let srv: Awaited<ReturnType<typeof listen>>;
  const calls = { create: 0, other: 0, fail: 0 };
  before(async () => {
    t = await tempStore();
    store = await t.open();
    const app = express();
    app.use(express.json());
    const once = idempotent(store);
    app.post("/create", once, (_req, res) => res.status(201).json({ n: ++calls.create }));
    app.post("/other", once, (_req, res) => res.json({ n: ++calls.other }));
    app.route("/both")
      .get(once, (_req, res) => res.json({ via: "get" }))
      .post(once, (_req, res) => res.json({ via: "post" }));
    app.post("/fail", once, (_req, res) => {
      calls.fail++;
      res.status(calls.fail === 1 ? 409 : 200).json({ attempt: calls.fail });
    });
    app.use(errorMiddleware);
    srv = await listen(app);
  });
  after(async () => {
    await srv.close();
    await store.close();
    await t.cleanup();
  });

  const post = (path: string, key?: string, method = "POST") =>
    fetch(`${srv.base}${path}`, { method, headers: key === undefined ? {} : { "idempotency-key": key } });

  test("without a key every request runs", async () => {
    const before = calls.create;
    await post("/create");
    await post("/create");
    assert.equal(calls.create, before + 2);
  });

  test("a repeated key replays the stored status and body without running the handler again", async () => {
    const first = await post("/create", "k-replay");
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("idempotent-replay"), null);
    const firstBody = (await first.json()) as { n: number };
    const ran = calls.create;
    const second = await post("/create", "k-replay");
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await second.json(), firstBody);
    assert.equal(calls.create, ran);
  });

  test("different keys are independent", async () => {
    const a = (await (await post("/create", "k-a")).json()) as { n: number };
    const b = (await (await post("/create", "k-b")).json()) as { n: number };
    assert.notEqual(a.n, b.n);
  });

  test("reusing a key on a different route is a 400", async () => {
    await post("/create", "k-route");
    const res = await post("/other", "k-route");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: { code: "invalid", message: "Idempotency-Key was already used for a different request" } });
    assert.equal(calls.other, 0, "the second handler never ran");
  });

  test("the method is part of the route a key is bound to", async () => {
    assert.deepEqual(await (await post("/both", "k-method", "GET")).json(), { via: "get" });
    const crossed = await post("/both", "k-method", "POST");
    assert.equal(crossed.status, 400, "the POST is not mistaken for the stored GET");
    assert.match(((await crossed.json()) as { error: { message: string } }).error.message, /different request/);
    assert.equal((await post("/both", "k-method", "GET")).headers.get("idempotent-replay"), "true");
  });

  test("a key longer than 128 characters is rejected, 128 is fine", async () => {
    const tooLong = await post("/create", "x".repeat(129));
    assert.equal(tooLong.status, 400);
    assert.deepEqual(await tooLong.json(), { error: { code: "invalid", message: "Idempotency-Key too long" } });
    assert.equal((await post("/create", "y".repeat(128))).status, 201);
  });

  test("an error response is not remembered, so a retry runs again", async () => {
    const first = await post("/fail", "k-fail");
    assert.equal(first.status, 409);
    const retry = await post("/fail", "k-fail");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { attempt: 2 });
    const again = await post("/fail", "k-fail");
    assert.equal(again.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await again.json(), { attempt: 2 });
    assert.equal(calls.fail, 2);
  });

  test("the first stored answer wins over a later one for the same key", async () => {
    store.remember("k-first", "POST /x", 201, { v: 1 });
    store.remember("k-first", "POST /x", 201, { v: 2 });
    assert.deepEqual(store.replay("k-first", "POST /x"), { status: 201, body: { v: 1 } });
    assert.equal(store.replay("k-unknown", "POST /x"), undefined);
    assert.throws(() => store.replay("k-first", "POST /y"), /already used for a different request/);
  });
});
