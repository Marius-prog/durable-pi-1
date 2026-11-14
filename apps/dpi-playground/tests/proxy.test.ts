import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import express from "express";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import { delay, newToken, stubDevice, tempRegistry, until, type StubDevice } from "./support.js";

// The hub's proxy mounted the way main.ts mounts it, in front of a stub device and a real monitor.
let stub: StubDevice;
let tmp: ReturnType<typeof tempRegistry>;
let monitor: DeviceMonitor;
let server: Server;
let base = "";

before(async () => {
  stub = await stubDevice();
  tmp = tempRegistry();
  tmp.registry.upsert({
    id: "box",
    name: "Box",
    url: stub.base,
    token: stub.token,
    source: "config",
  });
  monitor = new DeviceMonitor(tmp.registry);
  monitor.start();
  await until(() => monitor.state("box")?.status === "online", 8000, "box online");
  const app = express();
  app.use("/api", express.json());
  app.all("/api/devices/:id/v1/{*rest}", proxy(tmp.registry, monitor));
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  monitor.stop();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await stub.stop();
  await tmp.cleanup();
});

const echoed = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${base}/api/devices/box/v1/echo/${path}`, init);
  assert.equal(r.status, 200);
  return (await r.json()) as {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
  };
};
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const backToOnline = async () => {
  tmp.registry.setToken("box", stub.token);
  monitor.check("box");
  await until(() => monitor.state("box")?.status === "online", 8000, "box online again");
};

describe("proxy: token injection", () => {
  test("the device sees the registry token as a bearer token and as x-dpi-token", async () => {
    const e = await echoed("a");
    assert.equal(e.headers.authorization, `Bearer ${stub.token}`);
    assert.equal(e.headers["x-dpi-token"], stub.token);
  });

  test("a token the browser sends is replaced, not forwarded", async () => {
    const e = await echoed("b", {
      headers: { authorization: "Bearer browser-chose-this", "x-dpi-token": "browser-chose-this" },
    });
    assert.equal(e.headers.authorization, `Bearer ${stub.token}`);
    assert.equal(e.headers["x-dpi-token"], stub.token);
  });

  test("the hub adds no token to its response headers", async () => {
    const r = await fetch(`${base}/api/devices/box/v1/echo/c`);
    assert.equal(JSON.stringify([...r.headers]).includes(stub.token), false);
    assert.equal(
      r.headers.get("x-stub"),
      null,
      "device headers other than the content type are not copied",
    );
  });

  test("the browser's cookie, user agent and host are not passed to the device", async () => {
    const e = await echoed("d", { headers: { cookie: "s=1", "user-agent": "browser" } });
    assert.equal(e.headers.cookie, undefined);
    assert.notEqual(e.headers["user-agent"], "browser");
    assert.notEqual(e.headers.host, new URL(base).host, "the device sees its own host");
  });

  test("the idempotency key is forwarded when the browser sends one", async () => {
    const e = await echoed("e", post({ x: 1 }, { "idempotency-key": "key-123" }));
    assert.equal(e.headers["idempotency-key"], "key-123");
    const without = await echoed("f", post({ x: 1 }));
    assert.equal(without.headers["idempotency-key"], undefined);
  });
});

describe("proxy: request shape", () => {
  test("path and query string go through as written", async () => {
    const e = await echoed("deep/path%20x?a=1&b=two%2Fthree");
    assert.equal(e.url, "/v1/echo/deep/path%20x?a=1&b=two%2Fthree");
  });

  test("GET, HEAD and DELETE carry no body", async () => {
    for (const method of ["GET", "DELETE"]) {
      const e = await echoed("nobody", { method });
      assert.equal(e.method, method);
      assert.equal(e.body, "");
      assert.equal(e.headers["content-type"], undefined);
    }
  });

  for (const method of ["POST", "PUT", "PATCH"]) {
    test(`${method} sends its JSON body with a JSON content type`, async () => {
      const e = await echoed("body", { ...post({ hello: "wörld", n: [1, 2] }), method });
      assert.equal(e.method, method);
      assert.deepEqual(JSON.parse(e.body), { hello: "wörld", n: [1, 2] });
      assert.equal(e.headers["content-type"], "application/json");
    });
  }

  test("a write with no body is forwarded as an empty JSON object", async () => {
    const e = await echoed("empty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(e.body, "{}");
  });

  test("the device's status, JSON body and content type come back unchanged", async () => {
    const r = await fetch(`${base}/api/devices/box/v1/missing`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type")!, /^application\/json/);
    assert.deepEqual(await r.json(), { error: { code: "not_found", message: "no such thing" } });
  });

  test("a non-JSON answer keeps its content type", async () => {
    const r = await fetch(`${base}/api/devices/box/v1/text`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /^text\/plain/);
    assert.equal(await r.text(), "plain words");
  });

  test("a device that rejects the token comes back as its own 401, not a hub error", async () => {
    tmp.registry.setToken("box", newToken());
    try {
      const r = await fetch(`${base}/api/devices/box/v1/echo/x`);
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error.code, "unauthorized");
    } finally {
      await backToOnline();
    }
  });
});

describe("proxy: streams are refused", () => {
  const paths = [
    "events",
    "events?docs=a,b",
    "sessions/s1/events",
    "sessions/s1/agents/1/events",
    "sessions/s1/agents/1/events?docs=demo.job-runs",
  ];
  for (const path of paths)
    test(`/v1/${path} is 400 and never reaches the device`, async () => {
      const before = stub.hits.length;
      const r = await fetch(`${base}/api/devices/box/v1/${path}`);
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.code, "invalid");
      assert.match(body.error.message, /\/api\/stream/);
      assert.equal(stub.hits.length, before);
    });

  test("any method is refused on a stream path", async () => {
    const r = await fetch(`${base}/api/devices/box/v1/sessions/s1/events`, post({}));
    assert.equal(r.status, 400);
  });

  test("only a path that ENDS in /events is refused", async () => {
    const e = await echoed("events-history");
    assert.equal(e.url, "/v1/echo/events-history");
    const inner = await echoed("events/extra");
    assert.equal(inner.url, "/v1/echo/events/extra");
  });
});

describe("proxy: devices that cannot answer", () => {
  test("an unknown device is 404", async () => {
    const r = await fetch(`${base}/api/devices/ghost/v1/device`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, "not_found");
  });

  test("a device the monitor has not checked yet is 503 and says it is checking", async () => {
    tmp.registry.upsert({
      id: "fresh",
      name: "Fresh",
      url: "http://127.0.0.1:1",
      token: newToken(),
      source: "config",
    });
    const r = await fetch(`${base}/api/devices/fresh/v1/device`);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.error.code, "unavailable");
    assert.equal(body.error.message, "Fresh is checking");
  });

  test("a device with no token is 503 with the monitor's reason", async () => {
    tmp.registry.upsert({
      id: "notoken",
      name: "No Token",
      url: "http://127.0.0.1:1",
      source: "config",
    });
    monitor.watch("notoken");
    await until(() => monitor.state("notoken")?.status === "unauthorized", 5000, "unauthorized");
    const r = await fetch(`${base}/api/devices/notoken/v1/device`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error.message, /^No Token is unauthorized: No token for notoken/);
    monitor.forget("notoken");
  });

  for (const [id, status, init] of [
    ["offline", "offline", {}],
    ["incompat", "incompatible", { apiVersion: 2 }],
    ["wrongdev", "mismatch", {}],
  ] as const)
    test(`${/^[aeiou]/.test(status) ? "an" : "a"} ${status} device is 503 and names its state and reason, without calling it`, async () => {
      const other = await stubDevice(init);
      try {
        tmp.registry.upsert({
          id,
          name: id,
          url: other.base,
          token: other.token,
          source: "config",
        });
        if (status === "offline") await other.stop();
        if (status === "mismatch") tmp.registry.learnUid(id, "someone-else");
        monitor.watch(id);
        await until(() => monitor.state(id)?.status === status, 8000, `${id} ${status}`);
        const hits = other.hits.length;
        const r = await fetch(`${base}/api/devices/${id}/v1/echo/x`);
        assert.equal(r.status, 503);
        const { error } = await r.json();
        assert.equal(error.code, "unavailable");
        assert.ok(error.message.startsWith(`${id} is ${status}: `), error.message);
        assert.equal(other.hits.length, hits, "the proxy did not forward the request");
      } finally {
        monitor.forget(id);
        await other.stop();
      }
    });

  test("a token removed after the device was seen online is 503, not an unauthenticated forward", async () => {
    tmp.registry.setToken("box", null);
    try {
      const before = stub.hits.length;
      const r = await fetch(`${base}/api/devices/box/v1/echo/x`);
      assert.equal(r.status, 503);
      assert.equal(stub.hits.length, before);
    } finally {
      await backToOnline();
    }
  });

  test("a device that drops the connection is 502 and triggers a re-check", async () => {
    const r = await fetch(`${base}/api/devices/box/v1/boom`);
    assert.equal(r.status, 502);
    const { error } = await r.json();
    assert.equal(error.code, "offline");
    assert.match(error.message, /^Box did not answer: /);
    assert.equal(monitor.state("box")?.status, "checking", "monitor.check() ran");
    await until(() => monitor.state("box")?.status === "online", 8000, "box online again");
  });

  test("a device that is gone mid-flight is 502, and 503 once the monitor has seen it offline", async () => {
    const other = await stubDevice();
    try {
      tmp.registry.upsert({
        id: "flaky",
        name: "Flaky",
        url: other.base,
        token: other.token,
        source: "config",
      });
      monitor.watch("flaky");
      await until(() => monitor.state("flaky")?.status === "online", 5000, "flaky online");
      await other.stop();
      // The monitor has not noticed yet in the first instant, so the first answer is 502 or 503.
      const first = await fetch(`${base}/api/devices/flaky/v1/echo/x`);
      assert.ok([502, 503].includes(first.status), String(first.status));
      await until(() => monitor.state("flaky")?.status === "offline", 8000, "flaky offline");
      assert.equal((await fetch(`${base}/api/devices/flaky/v1/echo/x`)).status, 503);
    } finally {
      monitor.forget("flaky");
      await other.stop();
    }
  });

  test("a browser that gives up cancels the upstream request and does not trigger a re-check", async () => {
    const checks = stub.hitsTo("/v1/device").length;
    const closedBefore = stub.closedByClient.filter((u) => u === "/v1/hang").length;
    const abort = new AbortController();
    const pending = fetch(`${base}/api/devices/box/v1/hang`, { signal: abort.signal }).catch(
      (e) => e,
    );
    await until(() => stub.hitsTo("/v1/hang").length >= 1, 5000, "request reached the device");
    abort.abort();
    assert.ok((await pending) instanceof Error);
    await until(
      () => stub.closedByClient.filter((u) => u === "/v1/hang").length > closedBefore,
      5000,
      "upstream request cancelled",
    );
    await delay(150);
    assert.equal(
      monitor.state("box")?.status,
      "online",
      "no re-check: the device did nothing wrong",
    );
    assert.equal(stub.hitsTo("/v1/device").length, checks);
  });
});

describe("proxy: ids", () => {
  test("ids that are not valid device ids are plain 404s", async () => {
    for (const id of ["BOX", "box%20x", "..", "box.evil"]) {
      const r = await fetch(`${base}/api/devices/${id}/v1/device`);
      assert.equal(r.status, 404, id);
    }
  });
});
