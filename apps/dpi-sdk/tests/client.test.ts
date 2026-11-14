import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentHandle, DpiClient, SessionHandle, follow, type ConnectionState } from "../src/client.js";
import { DpiError } from "../src/errors.js";
import type { Frame } from "../src/api.js";

// A real HTTP server on the loopback interface stands in for dpi-backend: no external network is touched.

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
  fn: (ctx: { url: string; seen: Seen[] }) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn({ url, seen });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const echo = (_req: IncomingMessage, res: ServerResponse) => json(res, 200, { ok: true });

/** A loopback port nothing listens on: connecting is refused immediately. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const sse = (res: ServerResponse, frames: unknown[], end = true) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  if (end) res.end();
};

// ------------------------------------------------------------------ DpiClient.request

test("the base URL loses trailing slashes and the token goes out in both auth headers", async () => {
  assert.equal(new DpiClient("http://box:4780///").baseUrl, "http://box:4780");
  await withServer(echo, async ({ url, seen }) => {
    await new DpiClient(url + "/", "secret-token").device();
    assert.equal(seen[0].url, "/v1/device");
    assert.equal(seen[0].headers.authorization, "Bearer secret-token");
    assert.equal(seen[0].headers["x-dpi-token"], "secret-token");
    assert.equal(seen[0].headers["content-type"], undefined, "a GET without a body sends no content-type");
  });
});

test("a client without a token sends no auth headers; a body adds content-type and JSON", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const client = new DpiClient(url);
    await client.request("GET", "/v1/device");
    await client.request("POST", "/v1/x", { a: 1, nested: { b: [true] } });
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers["x-dpi-token"], undefined);
    assert.equal(seen[1].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen[1].body), { a: 1, nested: { b: [true] } });
  });
});

test("request returns parsed JSON, undefined for an empty body and for non-JSON success bodies", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/empty") res.writeHead(204).end();
      else if (req.url === "/text") res.writeHead(200).end("not json");
      else json(res, 200, { hello: "world" });
    },
    async ({ url }) => {
      const client = new DpiClient(url);
      assert.deepEqual(await client.request("GET", "/json"), { hello: "world" });
      assert.equal(await client.request("DELETE", "/empty"), undefined);
      assert.equal(await client.request("GET", "/text"), undefined);
    },
  );
});

test("the idempotency key is sent as a header only when given", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const client = new DpiClient(url);
    await client.request("POST", "/a", {}, { idempotencyKey: "key-1" });
    await client.request("POST", "/b", {});
    assert.equal(seen[0].headers["idempotency-key"], "key-1");
    assert.equal(seen[1].headers["idempotency-key"], undefined);
  });
});

test("error responses map to DpiError with the server's code, message and status", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/coded") json(res, 409, { error: { code: "conflict", message: "Already running" } });
      else if (req.url === "/401") res.writeHead(401, "Unauthorized").end();
      else if (req.url === "/404") json(res, 404, { nothing: "useful" });
      else if (req.url === "/500") res.writeHead(500, "Boom").end("<html>oops</html>");
      else if (req.url === "/no-message") json(res, 400, { error: { code: "bad_request" } });
      else res.writeHead(418, "Teapot").end();
    },
    async ({ url }) => {
      const client = new DpiClient(url);
      const fail = async (path: string) => {
        try {
          await client.request("GET", path);
        } catch (e) {
          return e as DpiError;
        }
        throw new Error(`${path} did not fail`);
      };
      const coded = await fail("/coded");
      assert.ok(coded instanceof DpiError);
      assert.deepEqual([coded.code, coded.message, coded.status], ["conflict", "Already running", 409]);
      const unauth = await fail("/401");
      assert.deepEqual([unauth.code, unauth.status, unauth.message], ["unauthorized", 401, "401 Unauthorized"]);
      const missing = await fail("/404");
      assert.deepEqual([missing.code, missing.status], ["not_found", 404]);
      const server = await fail("/500");
      assert.deepEqual([server.code, server.status, server.message], ["internal", 500, "500 Boom"]);
      const noMessage = await fail("/no-message");
      assert.deepEqual([noMessage.code, noMessage.message], ["bad_request", "400 Bad Request"]);
      assert.equal((await fail("/other")).code, "internal");
    },
  );
});

test("an unreachable device raises an offline DpiError that keeps the cause", async () => {
  const base = await closedPort();
  await assert.rejects(new DpiClient(base).device(), (e: unknown) => {
    assert.ok(e instanceof DpiError);
    assert.equal(e.code, "offline");
    assert.equal(e.status, 0);
    assert.equal(e.message, `Cannot reach ${base}`);
    assert.ok(e.cause, "the fetch failure is kept as the cause");
    return true;
  });
});

test("a request that outlives its timeout is reported as offline", async () => {
  await withServer(
    () => {
      /* never answers */
    },
    async ({ url }) => {
      await assert.rejects(
        new DpiClient(url).request("GET", "/slow", undefined, { timeoutMs: 60 }),
        (e: unknown) => e instanceof DpiError && e.code === "offline",
      );
    },
  );
});

test("a caller abort rethrows the original abort error instead of an offline DpiError", async () => {
  await withServer(
    () => {
      /* never answers */
    },
    async ({ url }) => {
      const controller = new AbortController();
      const pending = new DpiClient(url).request("GET", "/slow", undefined, { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(pending, (e: unknown) => !(e instanceof DpiError) && (e as Error).name === "AbortError");
    },
  );
  // An already-aborted signal fails the same way, before any request goes out.
  const aborted = AbortSignal.abort();
  await assert.rejects(
    new DpiClient("http://127.0.0.1:1").request("GET", "/x", undefined, { signal: aborted }),
    (e: unknown) => !(e instanceof DpiError),
  );
});

// ------------------------------------------------------------------ handles

test("session and agent handles hit the documented routes with the documented bodies", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const client = new DpiClient(url, "t");
    const session = client.session("s 1/x");
    const agent = client.agent("s1", 7);
    assert.ok(session instanceof SessionHandle && agent instanceof AgentHandle);
    assert.equal(session.base, "/v1/sessions/s%201%2Fx");
    assert.equal(agent.base, "/v1/sessions/s1/agents/7");
    assert.equal(client.agent("s1", "main/1").base, "/v1/sessions/s1/agents/main%2F1");

    const calls: [() => Promise<unknown>, string, string, unknown?][] = [
      [() => client.tree(), "GET", "/v1/tree"],
      [() => client.dirs(), "GET", "/v1/fs/dirs?path="],
      [() => client.dirs("/a b&c"), "GET", "/v1/fs/dirs?path=%2Fa%20b%26c"],
      [() => client.deviceDoc("app/state"), "GET", "/v1/docs/app%2Fstate"],
      [() => client.sessions(), "GET", "/v1/sessions"],
      [() => session.get(), "GET", "/v1/sessions/s%201%2Fx"],
      [() => session.rename("New"), "PATCH", "/v1/sessions/s%201%2Fx", { name: "New" }],
      [() => session.archive(), "DELETE", "/v1/sessions/s%201%2Fx"],
      [() => session.agents(), "GET", "/v1/sessions/s%201%2Fx/agents"],
      [() => session.tasks(), "GET", "/v1/sessions/s%201%2Fx/tasks?status=terminal&limit=20"],
      [() => session.tasks("live", 5), "GET", "/v1/sessions/s%201%2Fx/tasks?status=live&limit=5"],
      [() => session.abortTask(12), "POST", "/v1/sessions/s%201%2Fx/tasks/12/abort", {}],
      [() => session.inspect(), "GET", "/v1/sessions/s%201%2Fx/inspect"],
      [() => session.compaction(), "GET", "/v1/sessions/s%201%2Fx/compaction"],
      [() => session.setCompaction({ enabled: false }), "PATCH", "/v1/sessions/s%201%2Fx/compaction", { enabled: false }],
      [() => session.submission(4), "GET", "/v1/sessions/s%201%2Fx/submissions/4?waitMs=0"],
      [() => session.submission(4, 1500), "GET", "/v1/sessions/s%201%2Fx/submissions/4?waitMs=1500"],
      [() => agent.get(), "GET", "/v1/sessions/s1/agents/7"],
      [() => agent.rename("Bob"), "PATCH", "/v1/sessions/s1/agents/7", { name: "Bob" }],
      [() => agent.withdraw(3), "DELETE", "/v1/sessions/s1/agents/7/inbox/3"],
      [() => agent.abort(), "POST", "/v1/sessions/s1/agents/7/abort", { background: false }],
      [() => agent.abort(true), "POST", "/v1/sessions/s1/agents/7/abort", { background: true }],
      [() => agent.config(), "GET", "/v1/sessions/s1/agents/7/config"],
      [() => agent.configure({ readOnly: true }), "PATCH", "/v1/sessions/s1/agents/7/config", { readOnly: true }],
      [() => agent.compact(), "POST", "/v1/sessions/s1/agents/7/compact", {}],
      [() => agent.compact("keep todos"), "POST", "/v1/sessions/s1/agents/7/compact", { instructions: "keep todos" }],
      [() => agent.reset("fresh"), "POST", "/v1/sessions/s1/agents/7/reset", { note: "fresh" }],
      [() => agent.transcript(), "GET", "/v1/sessions/s1/agents/7/transcript?format=json"],
      [() => agent.transcript("markdown"), "GET", "/v1/sessions/s1/agents/7/transcript?format=markdown"],
      [() => agent.doc("demo.jobs/1"), "GET", "/v1/sessions/s1/agents/7/docs/demo.jobs%2F1"],
      [() => agent.extensions(), "GET", "/v1/sessions/s1/agents/7/extensions"],
      [() => agent.setExtension({ name: "git", enabled: true }), "PATCH", "/v1/sessions/s1/agents/7/extensions", { name: "git", enabled: true }],
      [() => agent.setExtension({ prompt: "p1", enabled: false }), "PATCH", "/v1/sessions/s1/agents/7/extensions", { prompt: "p1", enabled: false }],
      [() => agent.demo("jobs/start", { id: 1 }), "POST", "/v1/sessions/s1/agents/7/demo/jobs/start", { id: 1 }],
      [() => agent.demo("jobs/x", { id: 2 }, "PUT"), "PUT", "/v1/sessions/s1/agents/7/demo/jobs/x", { id: 2 }],
    ];
    for (const [call, method, path, body] of calls) {
      const before = seen.length;
      await call();
      assert.equal(seen.length, before + 1, `${method} ${path}`);
      const got = seen.at(-1)!;
      assert.equal(got.method, method, path);
      assert.equal(got.url, path);
      assert.equal(got.headers.authorization, "Bearer t");
      if (body === undefined) assert.equal(got.body, "", `${method} ${path} sends no body`);
      else assert.deepEqual(JSON.parse(got.body), body, path);
    }
  });
});

test("create calls send an idempotency key: a fresh uuid by default, the caller's when given", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const client = new DpiClient(url);
    await client.createSession({ cwd: "/w" } as never);
    await client.createSession({ cwd: "/w" } as never);
    await client.createSession({ cwd: "/w" } as never, "mine");
    const session = client.session("s1");
    await session.createAgent();
    await session.createAgent({ name: "x" } as never, "agent-key");
    await client.agent("s1", 1).fork({ at: 3 } as never);
    await client.agent("s1", 1).fork({ at: 3 } as never, "fork-key");

    const keys = seen.map((s) => s.headers["idempotency-key"]);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.match(String(keys[0]), uuid);
    assert.match(String(keys[1]), uuid);
    assert.notEqual(keys[0], keys[1], "each call mints its own key");
    assert.equal(keys[2], "mine");
    assert.deepEqual(
      seen.slice(0, 3).map((s) => [s.method, s.url]),
      Array(3).fill(["POST", "/v1/sessions"]),
    );
    assert.deepEqual(JSON.parse(seen[3].body), {}, "createAgent defaults to an empty body");
    assert.equal(seen[3].url, "/v1/sessions/s1/agents");
    assert.match(String(keys[3]), uuid);
    assert.equal(keys[4], "agent-key");
    assert.equal(seen[5].url, "/v1/sessions/s1/agents/1/fork");
    assert.match(String(keys[5]), uuid);
    assert.equal(keys[6], "fork-key");
  });
});

test("send() posts content, whenBusy and a requestId; waitMs rides in the body", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const agent = new DpiClient(url).agent("s1", 2);
    await agent.send("hello");
    await agent.send("now", "steer", "req-9", 2500);
    const first = JSON.parse(seen[0].body);
    assert.equal(first.content, "hello");
    assert.equal(first.whenBusy, "followUp");
    assert.match(first.requestId, /^[0-9a-f-]{36}$/);
    assert.equal("waitMs" in first, false, "undefined waitMs is dropped by JSON");
    assert.equal(seen[0].url, "/v1/sessions/s1/agents/2/messages");
    assert.deepEqual(JSON.parse(seen[1].body), { content: "now", whenBusy: "steer", requestId: "req-9", waitMs: 2500 });
  });
});

test("entries() defaults to scope=all, limit=500 and adds the cursor only when given", async () => {
  await withServer(echo, async ({ url, seen }) => {
    const agent = new DpiClient(url).agent("s1", 2);
    await agent.entries();
    await agent.entries({ scope: "active", limit: 10, cursor: "abc def" });
    assert.equal(seen[0].url, "/v1/sessions/s1/agents/2/entries?scope=all&limit=500");
    const q = new URL(seen[1].url, "http://x").searchParams;
    assert.deepEqual([q.get("scope"), q.get("limit"), q.get("cursor")], ["active", "10", "abc def"]);
  });
});

test("submission() with waitMs lengthens the request timeout beyond the wait", async () => {
  await withServer(
    (_req, res) => setTimeout(() => json(res, 200, { status: "done" }), 120),
    async ({ url }) => {
      const session = new DpiClient(url).session("s1");
      assert.deepEqual(await session.submission(1, 100), { status: "done" });
    },
  );
});

// ------------------------------------------------------------------ stream

const hello = (n = 1): Frame => ({ type: "hello", apiVersion: 1, serverTime: n, scope: { kind: "device" } });

test("stream() yields each frame, sends accept and auth headers, and ends with the server", async () => {
  await withServer(
    (_req, res) => sse(res, [hello(1), { type: "usage", usage: { models: {}, tools: {} } }]),
    async ({ url, seen }) => {
      const client = new DpiClient(url, "tok");
      const frames: Frame[] = [];
      for await (const frame of client.deviceEvents(new AbortController().signal)) frames.push(frame);
      assert.deepEqual(frames.map((f) => f.type), ["hello", "usage"]);
      assert.equal(seen[0].url, "/v1/events");
      assert.equal(seen[0].headers.accept, "text/event-stream");
      assert.equal(seen[0].headers.authorization, "Bearer tok");
    },
  );
});

test("event stream routes encode the doc list and scope", async () => {
  await withServer(
    (_req, res) => sse(res, []),
    async ({ url, seen }) => {
      const client = new DpiClient(url);
      const signal = new AbortController().signal;
      for await (const _ of client.deviceEvents(signal, ["a b", "c"])) void _;
      for await (const _ of client.session("s1").events(signal)) void _;
      for await (const _ of client.agent("s1", 3).events(signal, ["demo.jobs", "x/y"])) void _;
      for await (const _ of client.agent("s1", 3).events(signal)) void _;
      assert.deepEqual(
        seen.map((s) => s.url),
        [
          "/v1/events?docs=a%20b,c",
          "/v1/sessions/s1/events",
          "/v1/sessions/s1/agents/3/events?docs=demo.jobs,x%2Fy",
          "/v1/sessions/s1/agents/3/events",
        ],
      );
    },
  );
});

test("stream() failure statuses become DpiErrors: body code, 401, else unavailable", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/coded") json(res, 404, { error: { code: "not_found", message: "No such session" } });
      else if (req.url === "/401") res.writeHead(401).end("denied");
      else res.writeHead(503).end("busy");
    },
    async ({ url }) => {
      const client = new DpiClient(url);
      const open = async (path: string) => {
        try {
          for await (const _ of client.stream(path, new AbortController().signal)) void _;
        } catch (e) {
          return e as DpiError;
        }
        throw new Error("stream did not fail");
      };
      const coded = await open("/coded");
      assert.deepEqual([coded.code, coded.message, coded.status], ["not_found", "No such session", 404]);
      const unauth = await open("/401");
      assert.deepEqual([unauth.code, unauth.status, unauth.message], ["unauthorized", 401, "Stream failed (401)"]);
      const busy = await open("/503");
      assert.deepEqual([busy.code, busy.status, busy.message], ["unavailable", 503, "Stream failed (503)"]);
    },
  );
});

test("stream() to an unreachable device throws offline; an aborted open returns quietly", async () => {
  const base = await closedPort();
  const client = new DpiClient(base);
  await assert.rejects(
    (async () => {
      for await (const _ of client.stream("/v1/events", new AbortController().signal)) void _;
    })(),
    (e: unknown) => e instanceof DpiError && e.code === "offline" && e.status === 0,
  );
  const aborted = AbortSignal.abort();
  const frames: Frame[] = [];
  for await (const frame of client.stream("/v1/events", aborted)) frames.push(frame);
  assert.deepEqual(frames, []);
});

test("aborting a live stream ends the generator without an error", async () => {
  await withServer(
    (_req, res) => sse(res, [hello()], false),
    async ({ url }) => {
      const controller = new AbortController();
      const frames: Frame[] = [];
      for await (const frame of new DpiClient(url).deviceEvents(controller.signal)) {
        frames.push(frame);
        controller.abort();
      }
      assert.deepEqual(frames.map((f) => f.type), ["hello"]);
    },
  );
});

test("a silent stream hits the idle timeout and surfaces as an offline error", async () => {
  await withServer(
    (_req, res) => sse(res, [hello()], false),
    async ({ url }) => {
      const client = new DpiClient(url);
      const seen: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const frame of client.stream("/v1/events", new AbortController().signal, 80)) seen.push(frame.type);
        })(),
        (e: unknown) => e instanceof DpiError && e.code === "offline",
      );
      assert.deepEqual(seen, ["hello"]);
    },
  );
});

// ------------------------------------------------------------------ follow

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function recorder() {
  const states: string[] = [];
  const frames: Frame[] = [];
  const errors: (DpiError | undefined)[] = [];
  return {
    states,
    frames,
    errors,
    onFrame: (f: Frame) => void frames.push(f),
    onState: (s: ConnectionState, e?: DpiError) => (states.push(s), errors.push(e)),
  };
}

test("follow: a hello frame marks the connection live; a stream that ends reports a disconnect", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rec = recorder();
    const controller = new AbortController();
    let opens = 0;
    const done = follow(
      async function* () {
        opens++;
        yield hello();
        yield { type: "usage", usage: { models: {}, tools: {} } } as Frame;
      },
      rec.onFrame,
      rec.onState,
      controller.signal,
    );
    await flush();
    assert.equal(opens, 1);
    assert.deepEqual(rec.states, ["connecting", "live"]);
    assert.deepEqual(rec.frames.map((f) => f.type), ["hello", "usage", "disconnected"]);
    assert.deepEqual(rec.frames.at(-1), { type: "disconnected", reason: "Stream ended" });
    controller.abort();
    await done;
  } finally {
    mock.timers.reset();
  }
});

test("follow: reconnects with 1s, 2s, 4s, 8s then a 15s cap, and a hello resets the backoff", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rec = recorder();
    const controller = new AbortController();
    let opens = 0;
    let succeedOn = -1;
    const done = follow(
      async function* () {
        opens++;
        if (opens === succeedOn) {
          yield hello();
          return;
        }
        throw new DpiError("offline", `down #${opens}`);
      },
      rec.onFrame,
      rec.onState,
      controller.signal,
    );
    await flush();
    assert.equal(opens, 1);
    for (const wait of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const before: number = opens;
      mock.timers.tick(wait - 1);
      await flush();
      assert.equal(opens, before, `still waiting ${wait - 1}ms in`);
      mock.timers.tick(1);
      await flush();
      assert.equal(opens, before + 1, `reconnects after ${wait}ms`);
    }
    // The next attempt succeeds, then ends: the wait afterwards is back to 1s, not 15s.
    succeedOn = opens + 1;
    mock.timers.tick(15_000);
    await flush();
    assert.equal(opens, succeedOn);
    assert.equal(rec.states.at(-1), "live");
    mock.timers.tick(999);
    await flush();
    assert.equal(opens, succeedOn, "no reconnect before 1s");
    mock.timers.tick(1);
    await flush();
    assert.equal(opens, succeedOn + 1, "backoff was reset by the hello");
    assert.ok(rec.frames.some((f) => f.type === "disconnected" && f.reason === "down #1"));
    assert.equal(rec.states.filter((s) => s === "offline").length, 8, "7 failures before the success, plus the attempt after it");
    controller.abort();
    await done;
  } finally {
    mock.timers.reset();
  }
});

test("follow: unauthorized and not_found stop for good with the matching state", async () => {
  for (const [code, state] of [
    ["unauthorized", "unauthorized"],
    ["not_found", "gone"],
  ] as const) {
    const rec = recorder();
    const error = new DpiError(code, "nope", 401);
    await follow(
      async function* () {
        throw error;
      },
      rec.onFrame,
      rec.onState,
      new AbortController().signal,
    );
    assert.deepEqual(rec.states, ["connecting", state]);
    assert.equal(rec.errors.at(-1), error);
    assert.deepEqual(rec.frames, [{ type: "disconnected", reason: "nope" }]);
  }
});

test("follow: plain errors and thrown non-errors are wrapped as offline DpiErrors", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rec = recorder();
    const controller = new AbortController();
    const failures: unknown[] = [new Error("socket hang up"), "string failure"];
    const done = follow(
      async function* () {
        throw failures.shift();
      },
      rec.onFrame,
      rec.onState,
      controller.signal,
    );
    await flush();
    mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(rec.states, ["connecting", "offline", "connecting", "offline"]);
    assert.ok(rec.errors[1] instanceof DpiError && rec.errors[1].code === "offline");
    assert.equal(rec.errors[1]?.message, "socket hang up");
    assert.equal(rec.errors[3]?.message, "string failure");
    assert.deepEqual(rec.frames.map((f) => f.type === "disconnected" && f.reason), ["socket hang up", "string failure"]);
    controller.abort();
    await done;
  } finally {
    mock.timers.reset();
  }
});

test("follow: aborting mid-stream or mid-wait returns without a disconnect frame or another connect", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Abort while frames are flowing.
    const live = recorder();
    const controller = new AbortController();
    await follow(
      async function* () {
        yield hello();
        controller.abort();
        yield { type: "usage", usage: { models: {}, tools: {} } } as Frame;
      },
      live.onFrame,
      live.onState,
      controller.signal,
    );
    assert.equal(live.frames.some((f) => f.type === "disconnected"), false);

    // Abort while sleeping between attempts.
    const waiting = recorder();
    const second = new AbortController();
    let opens = 0;
    const done = follow(
      async function* () {
        opens++;
        throw new DpiError("offline", "down");
      },
      waiting.onFrame,
      waiting.onState,
      second.signal,
    );
    await flush();
    second.abort();
    await done;
    mock.timers.tick(60_000);
    await flush();
    assert.equal(opens, 1);

    // An already-aborted signal never connects.
    const never = recorder();
    await follow(async function* () { opens++; }, never.onFrame, never.onState, AbortSignal.abort());
    assert.deepEqual(never.states, []);
    assert.equal(opens, 1);
  } finally {
    mock.timers.reset();
  }
});

test("follow end to end: frames from a real SSE stream reach onFrame and an abort stops it", async () => {
  let connections = 0;
  await withServer(
    (_req, res) => {
      connections++;
      sse(res, [hello(connections)]);
    },
    async ({ url }) => {
      const client = new DpiClient(url);
      const controller = new AbortController();
      const hellos: number[] = [];
      let live = 0;
      const done = follow(
        (signal) => client.deviceEvents(signal),
        (frame) => {
          if (frame.type === "hello") hellos.push(frame.serverTime);
        },
        (state) => {
          if (state === "live" && ++live === 1) setTimeout(() => controller.abort(), 40);
        },
        controller.signal,
      );
      await done;
      assert.deepEqual(hellos, [1]);
      assert.equal(connections, 1);
    },
  );
});
