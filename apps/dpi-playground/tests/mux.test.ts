import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux, parseSubKey } from "../apps/dpi-playground-hub/src/mux.js";
import {
  delay,
  openBrowserStream,
  stubDevice,
  tempRegistry,
  until,
  type StubDevice,
} from "./support.js";

describe("mux: parseSubKey", () => {
  test("a device key opens /v1/events, with its documents when it names some", () => {
    assert.deepEqual(parseSubKey("box/device"), {
      key: "box/device",
      deviceId: "box",
      path: "/v1/events",
    });
    assert.equal(
      parseSubKey("box/device?docs=app.shared-state").path,
      "/v1/events?docs=app.shared-state",
    );
    assert.equal(parseSubKey("box/device?docs=a,b.c-d").path, "/v1/events?docs=a,b.c-d");
  });

  test("a session key opens the session's events", () => {
    assert.deepEqual(parseSubKey("box/session/abc-123"), {
      key: "box/session/abc-123",
      deviceId: "box",
      path: "/v1/sessions/abc-123/events",
    });
  });

  test("an agent key opens the agent's events, with documents", () => {
    assert.equal(parseSubKey("box/agent/s1/7").path, "/v1/sessions/s1/agents/7/events");
    assert.equal(
      parseSubKey("box/agent/s1/7?docs=demo.job-runs,demo.workspace").path,
      "/v1/sessions/s1/agents/7/events?docs=demo.job-runs,demo.workspace",
    );
  });

  test("ids are decoded once and encoded once, so nothing in them can change the path", () => {
    assert.equal(parseSubKey("box/session/a%20b").path, "/v1/sessions/a%20b/events");
    assert.equal(parseSubKey("box/session/a%2Fb").path, "/v1/sessions/a%2Fb/events");
    assert.equal(
      parseSubKey("box/agent/a%2E%2E/b%3Fx").path,
      "/v1/sessions/a../agents/b%3Fx/events",
    );
  });

  test("a device key takes no extra path segment, so one device has one device stream", () => {
    assert.throws(() => parseSubKey("box/device/1"), /Invalid subscription key/);
    assert.throws(() => parseSubKey("box/device/a/b"), /Invalid subscription key/);
  });

  test("a malformed percent escape throws", () => {
    assert.throws(() => parseSubKey("box/session/%E0%A4%A"), URIError);
  });

  test("the key is returned as given, so the caller can match frames to it", () => {
    const key = "box/agent/s1/2?docs=x";
    assert.equal(parseSubKey(key).key, key);
  });

  const invalid = [
    "",
    "box",
    "nope/agent",
    "box/unknown",
    "box/session",
    "box/session/",
    "box/agent",
    "box/agent/s1",
    "box/session/s1/extra",
    "box/agent/s1/2/extra",
    "BOX/device",
    "-box/device",
    "box_x/device",
    `${"a".repeat(33)}/device`,
    "box/device?docs=UPPER",
    "box/device?docs=a b",
    "box/device?docs=a;b",
    "box/device?other=1",
    "/device",
    "box//device",
    " box/device",
    "box/device\n",
  ];
  for (const key of invalid)
    test(`rejects ${JSON.stringify(key)}`, () => {
      assert.throws(() => parseSubKey(key), /Invalid subscription key|URI/);
    });

  test("device ids of 1 to 32 characters are accepted", () => {
    assert.equal(parseSubKey("a/device").deviceId, "a");
    assert.equal(parseSubKey(`${"a".repeat(32)}/device`).deviceId.length, 32);
    assert.equal(parseSubKey("0-9/device").deviceId, "0-9");
  });
});

/** The mux behind the same two routes main.ts gives it, in front of a stub device and a real monitor. */
async function rig(t: TestContext, options: { stub?: Partial<StubDevice> } = {}) {
  const stub = await stubDevice(options.stub);
  const tmp = tempRegistry();
  tmp.registry.upsert({
    id: "box",
    name: "Box",
    url: stub.base,
    token: stub.token,
    source: "config",
  });
  const monitor = new DeviceMonitor(tmp.registry);
  monitor.start();
  const mux = new StreamMux(tmp.registry, monitor);
  const app = express();
  app.use("/api", express.json());
  app.get("/api/stream", (req, res) => mux.open(req, res));
  app.put("/api/stream/:streamId", (req, res) => {
    try {
      res.json(mux.subscribe(String(req.params.streamId), req.body?.subs));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      res.status(status).json({ error: { code: "x", message: (e as Error).message } });
    }
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browsers: { close(): void }[] = [];
  t.after(async () => {
    for (const b of browsers) b.close();
    monitor.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await stub.stop();
    await tmp.cleanup();
  });
  await until(() => monitor.state("box")?.status === "online", 8000, "box online");
  const open = async () => {
    const b = await openBrowserStream(base);
    browsers.push(b);
    return b;
  };
  /** Upstream streams the stub has open, without the monitor's own device stream. */
  const upstreams = () => stub.openUrls().filter((u) => u !== "/v1/events");
  return { stub, ...tmp, monitor, mux, base, open, upstreams };
}

const sessionOnly = (url: string) => url.includes("/sessions/");

describe("mux: a browser stream", () => {
  test("opens as an event stream, names itself, then sends the network", async (t) => {
    const r = await rig(t);
    const res = await fetch(`${r.base}/api/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    assert.match(res.headers.get("cache-control")!, /no-cache/);
    await res.body!.cancel();

    const b = await r.open();
    assert.equal(b.frames[0].sub, "hello");
    assert.deepEqual(b.frames[0].frame, { type: "stream", streamId: b.streamId });
    assert.match(b.streamId, /^[0-9a-f-]{36}$/);
    assert.equal(b.frames[1].sub, "network");
    assert.equal(b.frames[1].frame.type, "network");
  });

  test("every tab gets its own stream id, and the mux counts them until they close", async (t) => {
    const r = await rig(t);
    const a = await r.open();
    const b = await r.open();
    assert.notEqual(a.streamId, b.streamId);
    assert.equal(r.mux.size, 2);
    a.close();
    await until(() => r.mux.size === 1, 5000, "one stream left");
    b.close();
    await until(() => r.mux.size === 0, 5000, "no streams left");
  });

  test("network frames carry the live status of every device and no token", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await until(
      () =>
        b
          .framesFor("network")
          .some((f) => f.frame.type === "network" && f.frame.devices[0]?.status === "online"),
      5000,
      "an online network frame",
    );
    const last = b.framesFor("network").at(-1)!.frame;
    assert.equal(last.type === "network" && last.devices[0].hasToken, true);
    assert.equal(b.raw().includes(r.stub.token), false, "the token is not in the raw stream");
    assert.equal(b.raw().includes(r.registry.get("box")!.token!), false);
  });

  test("a status change pushes a new network frame", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await until(() => b.framesFor("network").length >= 1, 5000, "first network frame");
    const seen = b.framesFor("network").length;
    r.monitor.check("box");
    await until(() => b.framesFor("network").length > seen, 5000, "another network frame");
    const statuses = b
      .framesFor("network")
      .map((f) => (f.frame.type === "network" ? f.frame.devices[0].status : ""));
    assert.ok(statuses.includes("checking") || statuses.at(-1) === "online", statuses.join());
  });

  test("a closed tab stops hearing monitor changes", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    b.close();
    await until(() => r.mux.size === 0, 5000, "closed");
    const before = b.frames.length;
    r.monitor.check("box");
    await delay(200);
    assert.equal(b.frames.length, before);
  });
});

describe("mux: subscriptions", () => {
  test("PUT answers with the subscription set, network first", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    const res = await b.put(["box/device", "box/session/s1"]);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).subs, ["network", "box/device", "box/session/s1"]);
  });

  test("network is always on: naming it is harmless, and an empty list keeps it", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    assert.deepEqual((await (await b.put([])).json()).subs, ["network"]);
    assert.deepEqual((await (await b.put(["network", "box/device", "network"])).json()).subs, [
      "network",
      "box/device",
    ]);
    assert.deepEqual((await (await b.put([])).json()).subs, ["network"]);
    const seen = b.framesFor("network").length;
    r.monitor.check("box");
    await until(() => b.framesFor("network").length > seen, 5000, "network frames still arrive");
  });

  test("repeating a key in one request opens it once", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    const res = await b.put(["box/session/s1", "box/session/s1"]);
    assert.deepEqual((await res.json()).subs, ["network", "box/session/s1"]);
    await until(() => r.upstreams().length === 1, 5000, "one upstream");
    await delay(100);
    assert.equal(r.stub.hitsTo("/v1/sessions/s1/events").length, 1);
  });

  test("each key opens the right authenticated upstream", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put([
      "box/device?docs=app.shared-state",
      "box/session/s1",
      "box/agent/s1/3?docs=demo.job-runs,demo.workspace",
    ]);
    await until(() => r.upstreams().length === 3, 5000, "three upstreams");
    assert.ok(r.stub.hitsTo("/v1/events?docs=app.shared-state").length === 1);
    assert.ok(r.stub.hitsTo("/v1/sessions/s1/events").length === 1);
    assert.ok(
      r.stub.hitsTo("/v1/sessions/s1/agents/3/events?docs=demo.job-runs,demo.workspace").length ===
        1,
    );
    const hit = r.stub.hitsTo("/v1/sessions/s1/events")[0];
    assert.equal(hit.headers.authorization, `Bearer ${r.stub.token}`);
    assert.match(hit.headers.accept!, /text\/event-stream/);
  });

  test("every upstream frame is tagged with the key that asked for it", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/session/s1", "box/session/s2"]);
    await until(() => r.upstreams().length === 2, 5000, "two upstreams");
    await until(
      () =>
        b.framesFor("box/session/s1", "hello").length === 1 &&
        b.framesFor("box/session/s2", "hello").length === 1,
      5000,
      "hellos",
    );
    r.stub.push({ type: "tasks", tasks: [] }, (u) => u === "/v1/sessions/s2/events");
    await until(
      () => b.framesFor("box/session/s2", "tasks").length === 1,
      5000,
      "tasks frame on s2",
    );
    assert.equal(b.framesFor("box/session/s1", "tasks").length, 0, "s1 did not get s2's frame");
  });

  test("two tabs get their own upstreams and their own frames", async (t) => {
    const r = await rig(t);
    const a = await r.open();
    const b = await r.open();
    await a.put(["box/session/s1"]);
    await b.put(["box/session/s1"]);
    await until(() => r.upstreams().length === 2, 5000, "an upstream per tab");
    r.stub.push({ type: "tasks", tasks: [] });
    await until(
      () =>
        a.framesFor("box/session/s1", "tasks").length === 1 &&
        b.framesFor("box/session/s1", "tasks").length === 1,
      5000,
      "both got it",
    );
  });

  test("a PUT replaces the set: dropped keys close their upstream, kept keys stay open", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/session/s1", "box/session/s2"]);
    await until(() => r.upstreams().length === 2, 5000, "two upstreams");
    await b.put(["box/session/s2", "box/session/s3"]);
    await until(
      () => r.upstreams().sort().join() === "/v1/sessions/s2/events,/v1/sessions/s3/events",
      5000,
      `s1 closed and s3 opened (open: ${r.upstreams()})`,
    );
    assert.equal(r.stub.hitsTo("/v1/sessions/s2/events").length, 1, "s2 was not reopened");
    await b.put([]);
    await until(() => r.upstreams().length === 0, 5000, "all closed");
  });

  test("closing the browser stream closes every upstream", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/session/s1", "box/agent/s1/1"]);
    await until(() => r.upstreams().length === 2, 5000, "two upstreams");
    b.close();
    await until(() => r.upstreams().length === 0, 5000, "upstreams closed");
    await until(() => r.mux.size === 0, 5000, "stream forgotten");
  });

  test("the stream id of a closed stream is 404 'reconnect'", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    b.close();
    await until(() => r.mux.size === 0, 5000, "closed");
    const res = await b.put(["box/device"]);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error.message, /Stream closed; reconnect/);
    const never = await fetch(`${r.base}/api/stream/not-a-stream`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [] }),
    });
    assert.equal(never.status, 404);
  });

  test("a key for an unknown device is 404 and names the device", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    const res = await b.put(["ghost/session/s1"]);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error.message, /No device ghost/);
  });

  test("a failed PUT changes nothing (all or nothing)", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    const keep = await b.put(["box/session/s0"]);
    assert.equal(keep.status, 200);
    await until(() => r.upstreams().length === 1, 5000, "s0 open");
    // An unknown device after a valid new key: no new upstream, and s0 is not dropped.
    const res = await b.put(["box/session/s1", "ghost/session/s1"]);
    assert.equal(res.status, 404);
    await delay(200);
    assert.deepEqual(r.upstreams(), ["/v1/sessions/s0/events"]);
    // The same for an invalid key.
    assert.equal((await b.put(["box/session/s2", "nope"])).status, 400);
    await delay(200);
    assert.deepEqual(r.upstreams(), ["/v1/sessions/s0/events"]);
    assert.equal(r.stub.hitsTo("/v1/sessions/s1/events").length, 0);
  });
});

describe("mux: subscription limits and validation", () => {
  test("20 keys are accepted and 21 are not", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `box/session/s${i}`);
    const ok = await b.put(keys(20));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).subs.length, 21, "20 keys plus network");
    await until(() => r.upstreams().length === 20, 8000, "20 upstreams");
    const tooMany = await b.put(keys(21));
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error.message, /up to 20 keys/);
    await delay(100);
    assert.equal(r.upstreams().length, 20, "the refused request closed nothing");
  });

  test("subs must be a list of strings", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    for (const subs of [
      undefined,
      null,
      "box/device",
      { 0: "box/device" },
      7,
      [1],
      ["box/device", null],
      [["box/device"]],
    ]) {
      const res = await b.put(subs);
      assert.equal(res.status, 400, JSON.stringify(subs));
      assert.match((await res.json()).error.message, /list of up to 20 keys/);
    }
  });

  test("an invalid key is 400 and names it, and leaves the old set in place", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/session/s1"]);
    await until(() => r.upstreams().length === 1, 5000, "one upstream");
    for (const bad of [
      "nope/agent",
      "box/unknown",
      "Box/device",
      "box/session/s1/extra",
      "box/device?docs=A",
    ]) {
      const res = await b.put(["box/session/s2", bad]);
      assert.equal(res.status, 400, bad);
      assert.match(
        (await res.json()).error.message,
        new RegExp(`Invalid subscription key: ${bad.replace(/[?/]/g, ".")}`),
      );
    }
    await delay(100);
    assert.deepEqual(r.upstreams(), ["/v1/sessions/s1/events"], "still exactly the old set");
  });
});

describe("mux: upstream behaviour", () => {
  test("a device that says not_found or invalid gets a fault frame and is not retried", async (t) => {
    for (const code of ["not_found", "invalid", "ambiguous"] as const) {
      const r = await rig(t, {
        stub: {
          eventsFailure: { status: 404, code, message: `no way: ${code}` },
          failMatch: sessionOnly,
        },
      });
      const b = await r.open();
      await b.put(["box/agent/s1/9"]);
      await until(() => b.framesFor("box/agent/s1/9", "fault").length === 1, 5000, `${code} fault`);
      const fault = b.framesFor("box/agent/s1/9", "fault")[0].frame;
      assert.deepEqual(fault.type === "fault" && fault.error, { code, message: `no way: ${code}` });
      // The retry backoff is 1s, so a retry would show within 1.3s; wait that long once.
      await delay(code === "not_found" ? 1300 : 100);
      assert.equal(
        r.stub.hitsTo("/v1/sessions/s1/agents/9/events").length,
        1,
        "no retry after a fault",
      );
    }
  });

  test("a rejected token is reported as disconnected and retried, not as a fault", async (t) => {
    const r = await rig(t, {
      stub: {
        eventsFailure: { status: 401, code: "unauthorized", message: "token no good" },
        failMatch: sessionOnly,
      },
    });
    const b = await r.open();
    await b.put(["box/session/s1"]);
    await until(
      () => b.framesFor("box/session/s1", "disconnected").length >= 1,
      5000,
      "disconnected",
    );
    const frame = b.framesFor("box/session/s1", "disconnected")[0].frame;
    assert.equal(frame.type === "disconnected" && frame.reason, "token no good");
    assert.equal(b.framesFor("box/session/s1", "fault").length, 0);
    await until(() => r.stub.hitsTo("/v1/sessions/s1/events").length >= 2, 5000, "a retry");
  });

  test("a stream that ends is reported as disconnected and reopened with a fresh hello", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/session/s1"]);
    await until(() => b.framesFor("box/session/s1", "hello").length === 1, 5000, "first hello");
    r.stub.endStreams(sessionOnly);
    await until(
      () => b.framesFor("box/session/s1", "disconnected").length === 1,
      5000,
      "disconnected",
    );
    const frame = b.framesFor("box/session/s1", "disconnected")[0].frame;
    assert.equal(frame.type === "disconnected" && frame.reason, "Stream ended");
    await until(
      () => b.framesFor("box/session/s1", "hello").length === 2,
      8000,
      "second hello after the backoff",
    );
  });

  test("a key for a device that is not online opens its upstream once the device is", async (t) => {
    const r = await rig(t);
    const late = await stubDevice();
    const port = late.port;
    await late.stop();
    r.registry.upsert({
      id: "late",
      name: "Late",
      url: late.base,
      token: late.token,
      source: "config",
    });
    r.monitor.watch("late");
    await until(() => r.monitor.state("late")?.status === "offline", 8000, "late offline");
    t.after(() => late.stop());
    const b = await r.open();
    await b.put(["late/session/s1"]);
    await delay(300);
    assert.equal(late.hits.length, 0, "nothing is sent to a device that is offline");
    assert.equal(b.framesFor("late/session/s1").length, 0);
    await late.start(port);
    r.monitor.check("late");
    await until(
      () => b.framesFor("late/session/s1", "hello").length === 1,
      10_000,
      "hello after the device came online",
    );
    assert.ok(late.hitsTo("/v1/sessions/s1/events").length >= 1);
  });

  test("no frame in the stream ever contains a device token", async (t) => {
    const r = await rig(t);
    const b = await r.open();
    await b.put(["box/device", "box/session/s1", "box/agent/s1/1?docs=demo.job-runs"]);
    await until(() => r.stub.clients.size >= 4, 5000, "the monitor's stream and three upstreams");
    r.stub.push({ type: "doc", kind: "demo.job-runs", value: { items: {} } });
    r.monitor.check("box");
    await delay(300);
    assert.ok(b.frames.length >= 6);
    assert.equal(b.raw().includes(r.stub.token), false);
  });
});
