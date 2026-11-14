// HubStream (the browser's one EventSource), the Vue feeds built on it, and the hub fetch helpers.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import type { Frame, NetworkDevice } from "../../dpi-sdk/src/api.js";
import {
  FakeEventSource,
  installBrowser,
  loadClient,
  type Browser,
  type ClientModules,
} from "./client-env.js";
import { delay, until } from "./support.js";

let browser: Browser;
let m: ClientModules & { unload(): Promise<void> };

before(async () => {
  browser = installBrowser();
  m = await loadClient();
  browser.attachDocument();
});
after(async () => {
  await m.unload();
  browser.restore();
});
beforeEach(() => {
  browser.fetch.reset();
  FakeEventSource.instances = [];
});

const puts = () => browser.fetch.to("PUT", /^\/api\/stream\//);
const bodies = () => puts().map((c) => (c.body as { subs: string[] }).subs);

/** A started stream that has said hello as `id`. */
function live(id = "s1") {
  const stream = new m.stream.HubStream();
  stream.start();
  FakeEventSource.latest.hello(id);
  return stream;
}

const device = (id: string, status: NetworkDevice["status"] = "online"): NetworkDevice => ({
  id,
  name: id,
  kind: "url",
  url: "http://x",
  source: "config",
  hasToken: true,
  status,
});

describe("HubStream: connection", () => {
  test("start() opens /api/stream and is connecting until the hub names the stream", () => {
    const stream = new m.stream.HubStream();
    assert.equal(stream.state, "connecting");
    stream.start();
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.latest.url, "/api/stream");
    assert.equal(stream.state, "connecting");
    FakeEventSource.latest.hello("abc");
    assert.equal(stream.state, "live");
  });

  test("onState hears each change once and stops after unsubscribing", () => {
    const stream = new m.stream.HubStream();
    const seen: string[] = [];
    const off = stream.onState((s) => seen.push(s));
    stream.start();
    FakeEventSource.latest.hello("a");
    FakeEventSource.latest.hello("a"); // live again: no change, no call
    FakeEventSource.latest.fail();
    assert.deepEqual(seen, ["live", "connecting"]);
    off();
    FakeEventSource.latest.hello("b");
    assert.deepEqual(seen, ["live", "connecting"]);
  });

  test("an error while EventSource is retrying leaves it connecting and does not open a second source", () => {
    const stream = live();
    FakeEventSource.latest.fail(FakeEventSource.CONNECTING);
    assert.equal(stream.state, "connecting");
    assert.equal(FakeEventSource.instances.length, 1);
  });

  test("an error that closes the source is offline, and the stream reopens after 2 seconds", async () => {
    const stream = live();
    FakeEventSource.latest.fail(FakeEventSource.CLOSED);
    assert.equal(stream.state, "offline");
    assert.equal(FakeEventSource.instances.length, 1);
    await until(() => FakeEventSource.instances.length === 2, 4000, "reopened");
    assert.equal(FakeEventSource.instances[0].closed, true, "the old source is closed first");
    assert.equal(FakeEventSource.latest.url, "/api/stream");
    stream.stop();
  });

  test("start() again closes the source it had", () => {
    const stream = new m.stream.HubStream();
    stream.start();
    stream.start();
    assert.equal(FakeEventSource.instances[0].closed, true);
    assert.equal(FakeEventSource.instances[1].closed, false);
  });

  test("stop() closes the source and cancels a pending subscription flush", async () => {
    const stream = live();
    stream.set("agent", "a/agent/s/1");
    stream.stop();
    assert.equal(FakeEventSource.latest.closed, true);
    await delay(80);
    assert.equal(puts().length, 0);
  });

  test("stop() before start() is harmless", () => {
    assert.doesNotThrow(() => new m.stream.HubStream().stop());
  });
});

describe("HubStream: subscriptions", () => {
  test("a slot's key is sent to the hub once the stream has an id, after a short debounce", async () => {
    const stream = live("s1");
    stream.set("agent", "a/agent/s/1");
    assert.equal(puts().length, 0, "debounced, not immediate");
    await until(() => puts().length === 1, 2000, "PUT");
    const call = puts()[0];
    assert.equal(call.url, "/api/stream/s1");
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, { subs: ["a/agent/s/1"] });
    stream.stop();
  });

  test("keys set before the hub names the stream are sent as soon as it does", async () => {
    const stream = new m.stream.HubStream();
    stream.start();
    stream.set("session", "a/session/s");
    await delay(80);
    assert.equal(puts().length, 0, "no stream id yet, nothing to PUT to");
    FakeEventSource.latest.hello("late");
    await until(() => puts().length === 1, 2000, "PUT after hello");
    assert.equal(puts()[0].url, "/api/stream/late");
    assert.deepEqual(bodies(), [["a/session/s"]]);
    stream.stop();
  });

  test("changes within the debounce collapse into one PUT with every slot's key, duplicates removed", async () => {
    const stream = live();
    stream.set("device", "a/device");
    stream.set("session", "a/session/s");
    stream.set("agent", "a/session/s");
    await until(() => puts().length === 1, 2000, "PUT");
    await delay(80);
    assert.deepEqual(bodies(), [["a/device", "a/session/s"]]);
    stream.stop();
  });

  test("setting the key a slot already has sends nothing", async () => {
    const stream = live();
    stream.set("agent", "k1");
    await until(() => puts().length === 1, 2000, "PUT");
    stream.set("agent", "k1");
    await delay(120);
    assert.equal(puts().length, 1);
    stream.stop();
  });

  test("switching a slot to a new key replaces the old key", async () => {
    const stream = live();
    stream.set("agent", "k1");
    await until(() => puts().length === 1, 2000, "first PUT");
    stream.set("agent", "k2");
    await until(() => puts().length === 2, 2000, "second PUT");
    assert.deepEqual(bodies(), [["k1"], ["k2"]]);
    stream.stop();
  });

  test("clearing a slot removes its key, and clearing the last one sends an empty list", async () => {
    const stream = live();
    stream.set("agent", "k1");
    stream.set("session", "k2");
    await until(() => puts().length === 1, 2000, "first PUT");
    stream.set("agent", undefined);
    await until(() => puts().length === 2, 2000, "second PUT");
    stream.set("session", undefined);
    await until(() => puts().length === 3, 2000, "third PUT");
    assert.deepEqual(bodies(), [["k1", "k2"], ["k2"], []]);
    stream.stop();
  });

  test("clearing a slot that was never set sends nothing", async () => {
    const stream = live();
    stream.set("agent", undefined);
    await delay(120);
    assert.equal(puts().length, 0);
    stream.stop();
  });

  test("re-selecting a key the hub still has open drops it first, so the hub sends a fresh snapshot", async () => {
    const stream = live();
    stream.set("agent", "k1");
    await until(() => puts().length === 1, 2000, "first PUT");
    stream.set("agent", undefined);
    stream.set("agent", "k1"); // same tick: the hub never saw the gap
    await until(() => puts().length === 3, 2000, "drop and re-add");
    assert.deepEqual(bodies(), [["k1"], [], ["k1"]]);
    stream.stop();
  });

  test("after the hub says hello again every subscription is sent again", async () => {
    const stream = live("s1");
    stream.set("agent", "k1");
    await until(() => puts().length === 1, 2000, "first PUT");
    FakeEventSource.latest.fail(FakeEventSource.CONNECTING); // EventSource reconnects by itself
    FakeEventSource.latest.hello("s2");
    await until(() => puts().length === 2, 2000, "PUT on the new stream");
    assert.equal(puts()[1].url, "/api/stream/s2");
    assert.deepEqual(bodies()[1], ["k1"]);
    stream.stop();
  });

  test("a 404 for the current stream means the hub restarted: the stream is reopened", async () => {
    browser.fetch.handler = () => ({
      status: 404,
      body: { error: { code: "not_found", message: "Stream closed; reconnect" } },
    });
    const stream = live("s1");
    stream.set("agent", "k1");
    await until(() => FakeEventSource.instances.length === 2, 2000, "reconnect");
    assert.equal(FakeEventSource.instances[0].closed, true);
    stream.stop();
  });

  test("a rejected key is warned about and the applied set stays as it was", async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const stream = live();
      stream.set("agent", "k1");
      await until(() => puts().length === 1, 2000, "first PUT");
      browser.fetch.handler = () => ({
        status: 400,
        body: { error: { code: "invalid", message: "bad key" } },
      });
      stream.set("agent", "k2");
      await until(() => warnings.length === 1, 2000, "warning");
      assert.equal(warnings[0][0], "subscription rejected");
      assert.match(String(warnings[0][1]), /bad key/);
      assert.equal(FakeEventSource.instances.length, 1, "not reopened");
      stream.stop();
    } finally {
      console.warn = warn;
    }
  });

  test("a failed PUT (the hub is unreachable) is retried after a second", async () => {
    let attempts = 0;
    browser.fetch.handler = () => {
      if (++attempts === 1) throw new TypeError("network down");
      return {};
    };
    const stream = live();
    stream.set("agent", "k1");
    await until(() => attempts === 1, 2000, "first attempt");
    await until(() => attempts === 2, 4000, "retry");
    assert.deepEqual(bodies().at(-1), ["k1"]);
    stream.stop();
  });
});

describe("HubStream: frames", () => {
  test("a frame goes to the handlers of the slot whose key it carries, and to nobody else", () => {
    const stream = live();
    const got: Record<string, Frame[]> = { device: [], session: [], agent: [] };
    for (const slot of ["device", "session", "agent"] as const)
      stream.route(slot, (f) => got[slot].push(f));
    stream.set("device", "a/device");
    stream.set("agent", "a/agent/s/1");
    const frame: Frame = { type: "tasks", tasks: [] };
    FakeEventSource.latest.send("a/agent/s/1", frame);
    FakeEventSource.latest.send("a/device", { type: "activity", items: [] });
    FakeEventSource.latest.send("other/key", frame);
    assert.deepEqual(got.agent, [frame]);
    assert.deepEqual(got.device, [{ type: "activity", items: [] }]);
    assert.deepEqual(got.session, []);
    stream.stop();
  });

  test("two slots on one key both get the frame", () => {
    const stream = live();
    const seen: string[] = [];
    stream.route("agent", () => seen.push("agent"));
    stream.route("session", () => seen.push("session"));
    stream.set("agent", "k");
    stream.set("session", "k");
    FakeEventSource.latest.send("k", { type: "tasks", tasks: [] });
    assert.deepEqual(seen.sort(), ["agent", "session"]);
    stream.stop();
  });

  test("a frame for a key the slot has since left is dropped", () => {
    const stream = live();
    const seen: Frame[] = [];
    stream.route("agent", (f) => seen.push(f));
    stream.set("agent", "old");
    stream.set("agent", "new");
    FakeEventSource.latest.send("old", { type: "tasks", tasks: [] });
    assert.equal(seen.length, 0);
    FakeEventSource.latest.send("new", { type: "tasks", tasks: [] });
    assert.equal(seen.length, 1);
    stream.stop();
  });

  test("a route can be removed", () => {
    const stream = live();
    const seen: Frame[] = [];
    const off = stream.route("agent", (f) => seen.push(f));
    stream.set("agent", "k");
    off();
    FakeEventSource.latest.send("k", { type: "tasks", tasks: [] });
    assert.equal(seen.length, 0);
    stream.stop();
  });

  test("network frames go to onNetwork handlers whatever the slots", () => {
    const stream = live();
    const seen: NetworkDevice[][] = [];
    const off = stream.onNetwork((d) => seen.push(d));
    FakeEventSource.latest.send("network", { type: "network", devices: [device("a")] });
    assert.deepEqual(seen, [[device("a")]]);
    off();
    FakeEventSource.latest.send("network", { type: "network", devices: [] });
    assert.equal(seen.length, 1);
    stream.stop();
  });

  test("the hello frame is not passed to slot handlers", () => {
    const stream = new m.stream.HubStream();
    stream.start();
    let calls = 0;
    stream.route("agent", () => calls++);
    stream.set("agent", "hello");
    FakeEventSource.latest.hello("x");
    assert.equal(calls, 0);
    stream.stop();
  });
});

// ------------------------------------------------------------------ composables

const snapshot = (overrides: Record<string, unknown> = {}): Frame => ({
  type: "snapshot",
  inbox: [],
  snapshot: {
    type: "snapshot",
    entries: [],
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
    ...overrides,
  },
});
const hello = (kind: "device" | "session" | "agent"): Frame => ({
  type: "hello",
  apiVersion: 1,
  serverTime: 0,
  scope: { kind },
});

describe("feeds over the stream", () => {
  test("useNetwork follows the network frames and builds the tree", async () => {
    const stream = live();
    const n = m.composables.useNetwork(stream);
    assert.deepEqual(n.devices.value, []);
    FakeEventSource.latest.send("network", {
      type: "network",
      devices: [device("a"), device("b", "offline")],
    });
    assert.deepEqual(
      n.devices.value.map((d) => [d.id, d.status]),
      [
        ["a", "online"],
        ["b", "offline"],
      ],
    );
    assert.deepEqual(
      n.tree.value.map((t) => [t.key, t.stale]),
      [
        ["a", false],
        ["b", true],
      ],
    );
    stream.stop();
  });

  test("useSession is idle without a target, subscribes when one appears and drops it when it goes", async () => {
    const { ref, nextTick } = m.vue;
    const stream = live();
    const target = ref<{ deviceId: string; sessionId: string } | undefined>();
    const s = m.composables.useSession(stream, target);
    assert.equal(s.status.value, "idle");
    target.value = { deviceId: "a", sessionId: "s1" };
    await nextTick();
    assert.equal(s.status.value, "connecting");
    await until(() => bodies().at(-1)?.join() === "a/session/s1", 2000, "subscribed");
    const FES = FakeEventSource.latest;
    FES.send("a/session/s1", hello("session"));
    assert.equal(s.status.value, "live");
    FES.send("a/session/s1", {
      type: "session",
      agents: [{ id: 1, name: "Main" } as never],
      tasks: [],
      usage: { models: {}, tools: {} },
    });
    assert.equal(s.state.value.ready, true);
    assert.equal(s.state.value.agents[0].name, "Main");
    target.value = undefined;
    await nextTick();
    assert.equal(s.status.value, "idle");
    assert.equal(s.state.value.ready, false, "the model is cleared");
    FES.send("a/session/s1", { type: "tasks", tasks: [{ id: 9 } as never] });
    assert.deepEqual(s.state.value.tasks, [], "frames for the old key are dropped");
    stream.stop();
  });

  test("a feed's status follows disconnected and fault frames, and a new target resets it", async () => {
    const { ref, nextTick } = m.vue;
    const stream = live();
    const target = ref<{ deviceId: string; sessionId: string } | undefined>({
      deviceId: "a",
      sessionId: "s1",
    });
    const s = m.composables.useSession(stream, target);
    const FES = FakeEventSource.latest;
    FES.send("a/session/s1", hello("session"));
    assert.equal(s.status.value, "live");
    FES.send("a/session/s1", { type: "disconnected", reason: "Stream ended" });
    assert.equal(s.status.value, "reconnecting");
    FES.send("a/session/s1", {
      type: "fault",
      error: { code: "not_found", message: "no such session" },
    });
    assert.equal(s.status.value, "fault");
    assert.equal(s.fault.value, "no such session");
    target.value = { deviceId: "a", sessionId: "s2" };
    await nextTick();
    assert.equal(s.status.value, "connecting");
    assert.equal(s.fault.value, "");
    stream.stop();
  });

  test("useAgent asks for the job and workspace documents and applies snapshots and documents", async () => {
    const { ref, nextTick } = m.vue;
    const stream = live();
    const target = ref<{ deviceId: string; sessionId: string; agentId: number } | undefined>({
      deviceId: "a",
      sessionId: "s1",
      agentId: 4,
    });
    const agent = m.composables.useAgent(stream, target);
    const key = "a/agent/s1/4?docs=demo.job-runs,demo.workspace";
    await until(() => bodies().at(-1)?.join() === key, 2000, "subscribed with docs");
    const FES = FakeEventSource.latest;
    assert.equal(agent.state.value.ready, false);
    const v0 = agent.version.value;
    FES.send(key, snapshot({ run: { inputs: [] }, agent: { thinkingLevel: "high" } }));
    assert.equal(agent.state.value.ready, true);
    assert.equal(agent.state.value.running, true);
    assert.equal(agent.state.value.agent.thinkingLevel, "high");
    assert.ok(agent.version.value > v0, "the version counter moved");
    FES.send(key, { type: "doc", kind: "demo.job-runs", value: { counts: {}, items: {} } });
    assert.deepEqual(agent.state.value.docs["demo.job-runs"], { counts: {}, items: {} });
    const before = agent.state.value;
    FES.send(key, { type: "inbox", items: [{ id: 1, mode: "followUp" }] });
    assert.notEqual(agent.state.value, before, "each change gives the views a fresh state object");
    target.value = { deviceId: "a", sessionId: "s1", agentId: 5 };
    await nextTick();
    assert.equal(agent.state.value.ready, false);
    await until(
      () => bodies().at(-1)?.join() === "a/agent/s1/5?docs=demo.job-runs,demo.workspace",
      2000,
      "resubscribed",
    );
    stream.stop();
  });

  test("useDevice keeps the shared state with its revision and the last 50 activities", async () => {
    const { ref, nextTick } = m.vue;
    const stream = live();
    const id = ref<string | undefined>("a");
    const d = m.composables.useDevice(stream, id);
    const key = "a/device?docs=app.shared-state";
    await until(() => bodies().at(-1)?.join() === key, 2000, "subscribed");
    const FES = FakeEventSource.latest;
    assert.equal(d.status.value, "connecting");
    FES.send(key, hello("device"));
    assert.equal(d.status.value, "live");
    FES.send(key, { type: "doc", kind: "app.shared-state", value: { x: 1 } as never, revision: 7 });
    assert.deepEqual(d.sharedState.value, { value: { x: 1 }, revision: 7 });
    FES.send(key, { type: "doc", kind: "app.shared-state", value: { x: 2 } as never });
    assert.equal(d.sharedState.value?.revision, 0, "no revision means 0");
    FES.send(key, { type: "doc", kind: "something.else", value: {} });
    assert.deepEqual(d.sharedState.value?.value, { x: 2 }, "other documents are ignored");
    const item = (n: number) => ({ id: n }) as never;
    FES.send(key, { type: "activity", items: Array.from({ length: 40 }, (_, i) => item(i)) });
    FES.send(key, { type: "activity", items: Array.from({ length: 30 }, (_, i) => item(100 + i)) });
    assert.equal(d.activity.value.length, 50);
    assert.deepEqual((d.activity.value.at(0) as unknown as { id: number }).id, 20);
    assert.deepEqual((d.activity.value.at(-1) as unknown as { id: number }).id, 129);
    id.value = "b";
    await nextTick();
    assert.equal(d.sharedState.value, undefined, "another device starts with no shared state");
    id.value = undefined;
    await nextTick();
    assert.equal(d.status.value, "idle");
    stream.stop();
  });
});

describe("subscription keys", () => {
  test("agentSub, sessionSub and deviceSub name what the hub's mux expects", () => {
    const c = m.composables;
    assert.equal(c.sessionSub({ deviceId: "box", sessionId: "s1" }), "box/session/s1");
    assert.equal(
      c.agentSub({ deviceId: "box", sessionId: "s1", agentId: 3 }),
      "box/agent/s1/3?docs=demo.job-runs,demo.workspace",
    );
    assert.equal(c.deviceSub("box"), "box/device?docs=app.shared-state");
    assert.deepEqual(c.AGENT_DOCS, ["demo.job-runs", "demo.workspace"]);
  });
});

describe("hub helpers", () => {
  test("network() is a plain GET", async () => {
    browser.fetch.handler = () => ({
      body: { configFile: "/x/dpi-network.yaml", devices: [device("a")] },
    });
    const net = await m.hub.hub.network();
    assert.equal(net.configFile, "/x/dpi-network.yaml");
    assert.equal(net.devices[0].id, "a");
    const [call] = browser.fetch.calls;
    assert.deepEqual([call.method, call.url, call.body], ["GET", "/api/network", undefined]);
    assert.equal(call.headers["content-type"], undefined, "a GET names no content type");
  });

  test("check() posts an empty JSON object to the encoded device id", async () => {
    browser.fetch.handler = () => ({ body: device("a b") });
    await m.hub.hub.check("a b");
    const [call] = browser.fetch.calls;
    assert.deepEqual([call.method, call.url, call.body], ["POST", "/api/devices/a%20b/check", {}]);
    assert.equal(call.headers["content-type"], "application/json");
  });

  test("uiGet() unwraps the value, maps null to undefined and encodes the key", async () => {
    browser.fetch.handler = () => ({ body: { value: { tree: true } } });
    assert.deepEqual(await m.hub.hub.uiGet("layout/panels"), { tree: true });
    assert.equal(browser.fetch.calls[0].url, "/api/ui-state/layout%2Fpanels");
    browser.fetch.handler = () => ({ body: { value: null } });
    assert.equal(await m.hub.hub.uiGet("never"), undefined);
    browser.fetch.handler = () => ({ body: { value: 0 } });
    assert.equal(await m.hub.hub.uiGet("zero"), 0, "falsy values survive");
  });

  test("uiSet() puts {value}", async () => {
    await m.hub.hub.uiSet("tree.width", 321);
    const [call] = browser.fetch.calls;
    assert.deepEqual(
      [call.method, call.url, call.body],
      ["PUT", "/api/ui-state/tree.width", { value: 321 }],
    );
  });

  test("an error body from the hub becomes a DpiError with its code, message and status", async () => {
    browser.fetch.handler = () => ({
      status: 404,
      body: { error: { code: "not_found", message: "No device zed" } },
    });
    await assert.rejects(m.hub.hub.check("zed"), (e: unknown) => {
      assert.ok(e instanceof DpiError || (e as Error).name === "DpiError");
      const err = e as DpiError;
      assert.deepEqual([err.code, err.message, err.status], ["not_found", "No device zed", 404]);
      return true;
    });
  });

  test("an error that is not our JSON becomes an internal error with the status line", async () => {
    browser.fetch.handler = () => ({
      status: 502,
      statusText: "Bad Gateway",
      raw: "<html>nope</html>",
    });
    await assert.rejects(m.hub.hub.network(), (e: unknown) => {
      const err = e as DpiError;
      assert.deepEqual([err.code, err.message, err.status], ["internal", "502 Bad Gateway", 502]);
      return true;
    });
    browser.fetch.handler = () => ({
      status: 400,
      statusText: "Bad Request",
      body: { unexpected: true },
    });
    await assert.rejects(m.hub.hub.network(), /400 Bad Request/);
  });

  test("deviceClient() talks to the hub's proxy and sends no token", async () => {
    const client = m.hub.deviceClient("a b");
    assert.equal(client.baseUrl, "/api/devices/a%20b");
    browser.fetch.handler = () => ({ body: { name: "x" } });
    await client.device();
    const [call] = browser.fetch.calls;
    assert.equal(call.url, "/api/devices/a%20b/v1/device");
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["x-dpi-token"], undefined);
  });

  test("message() reads an Error's message and stringifies anything else", () => {
    assert.equal(m.hub.message(new Error("boom")), "boom");
    assert.equal(m.hub.message("plain"), "plain");
    assert.equal(m.hub.message({ a: 1 }), "[object Object]");
    assert.equal(m.hub.message(undefined), "undefined");
  });
});
