import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import type { DeviceStatus, DeviceTree } from "../../dpi-sdk/src/api.js";
import { delay, newToken, stubDevice, tempRegistry, until, type StubDevice } from "./support.js";

const ID = "dev";

/** One stub device, a temp registry with that device in it, and a monitor that is not started yet. */
async function rig(
  t: TestContext,
  options: { init?: Partial<StubDevice>; token?: string | null } = {},
) {
  const stub = await stubDevice(options.init);
  const tmp = tempRegistry();
  const token = options.token === undefined ? stub.token : options.token;
  tmp.registry.upsert({ id: ID, name: "Dev", url: stub.base, source: "config", token });
  const monitor = new DeviceMonitor(tmp.registry);
  t.after(async () => {
    monitor.stop();
    await stub.stop();
    await tmp.cleanup();
  });
  const status = () => monitor.state(ID)?.status;
  const waitFor = (want: DeviceStatus, ms = 8000) =>
    until(() => status() === want, ms, `${ID} ${want} (is ${status()})`);
  /** Every distinct status the monitor reported through onChange, in order. */
  const seen: DeviceStatus[] = [];
  monitor.onChange(() => {
    const s = status();
    if (s && seen.at(-1) !== s) seen.push(s);
  });
  return { stub, ...tmp, monitor, status, waitFor, seen };
}

const tree = (name = "Dev"): DeviceTree => ({ uid: "u", name, sessions: [], at: 1 });

describe("monitor: coming online", () => {
  test("watch() starts in checking, then goes online with the device info, uid and last-seen time", async (t) => {
    const r = await rig(t);
    const before = Date.now();
    r.monitor.start();
    assert.equal(r.status(), "checking", "checking is synchronous, before the first probe returns");
    await r.waitFor("online");
    const live = r.monitor.state(ID)!;
    assert.equal(live.info?.uid, r.stub.uid);
    assert.equal(live.info?.name, "stub");
    assert.equal(live.error, undefined);
    assert.ok(live.lastSeenAt! >= before);
    assert.equal(r.registry.get(ID)!.deviceUid, r.stub.uid, "the uid is learned on first contact");
  });

  test("the probe sends the registry token as a bearer token", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    const probe = r.stub.hitsTo("/v1/device")[0];
    assert.equal(probe.headers.authorization, `Bearer ${r.stub.token}`);
    assert.equal(probe.headers["x-dpi-token"], r.stub.token);
  });

  test("online is saved in the registry, so a restarted hub shows the last known state", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    const row = r.registry.get(ID)!;
    assert.equal(row.lastStatus, "online");
    assert.equal(row.lastError, null);
    assert.equal(row.lastInfo?.uid, r.stub.uid);
    assert.ok(row.lastSeenAt);
  });

  test("a device the registry knows but the monitor never started reports its saved state", async (t) => {
    const r = await rig(t);
    r.registry.recordStatus(ID, { status: "offline", error: "was down" });
    const [d] = r.monitor.network();
    assert.equal(d.status, "offline");
    assert.equal(d.error, "was down");
    assert.equal(r.monitor.state(ID), undefined);
  });

  test("network() lists the registry's devices in order and never carries a token", async (t) => {
    const r = await rig(t);
    r.registry.upsert({
      id: "second",
      url: "http://127.0.0.1:1",
      token: newToken(),
      source: "config",
    });
    r.monitor.start();
    await r.waitFor("online");
    const devices = r.monitor.network();
    assert.deepEqual(
      devices.map((d) => d.id),
      [ID, "second"],
    );
    assert.equal(devices[0].hasToken, true);
    const text = JSON.stringify(devices);
    assert.equal(text.includes(r.stub.token), false);
    assert.equal(text.includes(r.registry.get("second")!.token!), false);
    assert.equal("token" in devices[0], false);
  });

  test("tree frames from the device stream update the tree and keep it online", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    const first = r.monitor.state(ID)!.lastSeenAt!;
    await delay(5);
    r.stub.push({ type: "tree", tree: tree("Fresh") });
    await until(() => r.monitor.state(ID)?.tree?.name === "Fresh", 5000, "tree applied");
    assert.equal(r.status(), "online");
    assert.ok(r.monitor.state(ID)!.lastSeenAt! >= first);
    assert.equal(r.monitor.network()[0].tree?.name, "Fresh");
  });

  test("a frame that is not a tree is ignored", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    r.stub.push({ type: "activity", items: [] });
    await delay(150);
    assert.equal(r.status(), "online");
    assert.equal(r.monitor.state(ID)!.tree, undefined);
  });

  test("repeated check() calls leave exactly one stream open", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    r.monitor.check(ID);
    r.monitor.check(ID);
    await r.waitFor("online");
    await until(
      () => r.stub.clients.size === 1 && r.stub.closedByClient.length >= 1,
      5000,
      "old stream closed",
    );
    assert.equal(r.stub.clients.size, 1);
  });
});

describe("monitor: unauthorized", () => {
  test("a device with no token is unauthorized and says how to fix it, without calling it", async (t) => {
    const r = await rig(t, { token: null });
    r.monitor.start();
    await r.waitFor("unauthorized");
    assert.match(r.monitor.state(ID)!.error!, /No token for dev\. Run: just net register dev/);
    await delay(100);
    assert.equal(r.stub.hits.length, 0, "no request leaves the hub without a token");
    const row = r.registry.get(ID)!;
    assert.equal(row.lastStatus, "unauthorized");
    assert.match(row.lastError!, /just net register/);
  });

  test("a token the device rejects is unauthorized, and check() after the fix brings it online", async (t) => {
    const r = await rig(t, { token: newToken() });
    r.monitor.start();
    await r.waitFor("unauthorized");
    assert.equal(r.monitor.state(ID)!.error, "Token rejected by the device");
    r.registry.setToken(ID, r.stub.token);
    r.monitor.check(ID);
    await r.waitFor("online");
    assert.equal(r.monitor.state(ID)!.error, undefined, "the error is cleared");
  });

  test("a stream that answers 401 after a good probe is unauthorized too", async (t) => {
    const r = await rig(t, {
      init: { eventsFailure: { status: 401, code: "unauthorized", message: "revoked" } },
    });
    r.monitor.start();
    await r.waitFor("unauthorized");
    assert.equal(r.monitor.state(ID)!.error, "Token rejected by the device");
    assert.equal(
      r.monitor.state(ID)!.info?.uid,
      r.stub.uid,
      "the probe had succeeded, so info is kept",
    );
  });

  test("clearing a token while the device is online sends it to unauthorized on the next check", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    r.registry.setToken(ID, null);
    r.monitor.check(ID);
    await r.waitFor("unauthorized");
    assert.match(r.monitor.state(ID)!.error!, /No token/);
  });
});

describe("monitor: incompatible and mismatch", () => {
  test("a device that speaks another API version is incompatible and named", async (t) => {
    const r = await rig(t, { init: { apiVersion: 2 } });
    r.monitor.start();
    await r.waitFor("incompatible");
    assert.match(r.monitor.state(ID)!.error!, /speaks API v2; this hub speaks v1/);
    assert.equal(r.stub.clients.size, 0, "no stream is opened to an incompatible device");
    assert.equal(r.registry.get(ID)!.deviceUid, null, "its uid is not learned");
  });

  test("a different device at the same URL is a mismatch, quoting both uids", async (t) => {
    const r = await rig(t, { init: { uid: "newdevice-1234567890", name: "impostor" } });
    r.registry.learnUid(ID, "olddevice-abcdefghij");
    r.monitor.start();
    await r.waitFor("mismatch");
    const error = r.monitor.state(ID)!.error!;
    assert.match(
      error,
      /now answers as "impostor" \(uid newdevic\), not the device first seen there \(uid olddevic\)/,
    );
    assert.equal(
      r.registry.get(ID)!.deviceUid,
      "olddevice-abcdefghij",
      "the remembered uid is not overwritten",
    );
    assert.equal(r.stub.clients.size, 0, "no stream is opened to the wrong device");
  });

  test("forgetting the uid and re-checking accepts the new device", async (t) => {
    const r = await rig(t);
    r.registry.learnUid(ID, "someone-else");
    r.monitor.start();
    await r.waitFor("mismatch");
    r.registry.forgetUid(ID);
    r.monitor.check(ID);
    await r.waitFor("online");
    assert.equal(r.registry.get(ID)!.deviceUid, r.stub.uid);
  });

  test("the same uid on a later probe is not a mismatch", async (t) => {
    const r = await rig(t);
    r.registry.learnUid(ID, r.stub.uid);
    r.monitor.start();
    await r.waitFor("online");
  });
});

describe("monitor: offline", () => {
  test("a device that never answers is offline with a reason and no last-seen time", async (t) => {
    const r = await rig(t);
    await r.stub.stop();
    r.monitor.start();
    await r.waitFor("offline");
    assert.match(r.monitor.state(ID)!.error!, /Cannot reach http:\/\/127\.0\.0\.1:/);
    assert.equal(r.monitor.state(ID)!.lastSeenAt, undefined);
    assert.equal(r.registry.get(ID)!.lastStatus, "offline");
  });

  test("an offline device is retried and comes online when it returns, with its tree kept meanwhile", async (t) => {
    const r = await rig(t, { init: { tree: tree("Cached") } });
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.monitor.state(ID)?.tree?.name === "Cached", 5000, "tree seen");
    const port = r.stub.port;
    await r.stub.stop();
    await r.waitFor("offline");
    const live = r.monitor.state(ID)!;
    assert.equal(live.tree?.name, "Cached", "the last known tree stays while offline");
    assert.ok(live.lastSeenAt, "a stream that was live until it failed counts as seen just now");
    assert.equal(
      r.registry.get(ID)!.lastTree?.name,
      "Cached",
      "and it is saved for the next hub start",
    );
    await r.stub.start(port);
    await r.waitFor("online", 10_000);
    assert.equal(r.monitor.state(ID)!.error, undefined);
  });

  test("a device that answers 500 is offline with its message", async (t) => {
    const r = await rig(t, { init: { deviceStatus: 500 } });
    r.monitor.start();
    await r.waitFor("offline");
    assert.equal(r.monitor.state(ID)!.error, "boom");
  });

  test("an event stream that ends is offline (device restarting) and the loop reconnects on its own", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    r.stub.endStreams();
    await until(() => r.seen.includes("offline"), 5000, "offline seen");
    assert.equal(r.monitor.state(ID)!.lastSeenAt !== undefined, true);
    await r.waitFor("online", 5000);
    assert.ok(r.seen.includes("offline"), `statuses seen: ${r.seen}`);
  });

  test("the offline reason of a stream that ended says so", async (t) => {
    const r = await rig(t, { init: { keepStreamsOpen: false } });
    r.monitor.start();
    await until(
      () => r.registry.get(ID)?.lastError === "Event stream ended (device restarting?)",
      5000,
      "stream-ended error",
    );
  });
});

describe("monitor: control", () => {
  test("check() re-probes at once and keeps the last known info visible while checking", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    r.monitor.check(ID);
    const live = r.monitor.state(ID)!;
    assert.equal(live.status, "checking");
    assert.equal(live.info?.uid, r.stub.uid, "info survives into the checking state");
    assert.equal(live.error, undefined);
    await r.waitFor("online");
  });

  test("settled() waits for the device to leave checking and returns its public view", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    const device = await r.monitor.settled(ID);
    assert.equal(device?.status, "online");
    assert.equal(device?.id, ID);
  });

  test("settled() gives up after its timeout and returns the device still checking", async (t) => {
    const r = await rig(t, { init: { hangDevice: true } });
    r.monitor.start();
    const started = Date.now();
    const device = await r.monitor.settled(ID, 300);
    assert.equal(device?.status, "checking");
    assert.ok(Date.now() - started < 3000);
  });

  test("settled() for an unknown id resolves to undefined", async (t) => {
    const r = await rig(t);
    assert.equal(await r.monitor.settled("nope", 200), undefined);
  });

  test("stop() ends every loop and closes the open stream", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    const hits = r.stub.hits.length;
    r.monitor.stop();
    await until(() => r.stub.clients.size === 0, 5000, "stream closed");
    await delay(150);
    assert.equal(r.stub.hits.length, hits, "no further requests");
  });

  test("forget() drops the live state, the loop and the stream, and the saved state shows through", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => r.stub.clients.size === 1, 5000, "events stream open");
    r.monitor.forget(ID);
    assert.equal(r.monitor.state(ID), undefined);
    await until(() => r.stub.clients.size === 0, 5000, "stream closed");
    assert.equal(
      r.monitor.network()[0].status,
      "online",
      "network() falls back to the registry row",
    );
  });

  test("a device removed from the registry ends its loop when it next wakes", async (t) => {
    const r = await rig(t, { init: { keepStreamsOpen: false } });
    r.monitor.start();
    await until(() => r.stub.hitsTo("/v1/device").length >= 1, 5000, "first probe");
    r.registry.remove(ID);
    await delay(1500);
    const hits = r.stub.hitsTo("/v1/device").length;
    await delay(1500);
    assert.equal(r.stub.hitsTo("/v1/device").length, hits, "the loop stopped probing");
  });

  test("watch() on an unknown id starts a loop that returns at once", async (t) => {
    const r = await rig(t);
    r.monitor.watch("ghost");
    assert.equal(r.monitor.state("ghost")?.status, "checking");
    await delay(50);
    assert.equal(r.registry.get("ghost"), undefined);
  });
});

describe("monitor: change notifications", () => {
  test("listeners hear about status changes, once per burst, and stop after unsubscribing", async (t) => {
    const r = await rig(t);
    let calls = 0;
    const off = r.monitor.onChange(() => calls++);
    r.monitor.start();
    await r.waitFor("online");
    await until(() => calls >= 1, 2000, "a notification");
    const afterOnline = calls;
    assert.ok(afterOnline <= 3, `bursts are debounced (got ${afterOnline})`);
    off();
    r.monitor.check(ID);
    await r.waitFor("online");
    await delay(150);
    assert.equal(calls, afterOnline, "an unsubscribed listener hears nothing more");
  });

  test("whenOnline() resolves at once for an online device", async (t) => {
    const r = await rig(t);
    r.monitor.start();
    await r.waitFor("online");
    const started = Date.now();
    await r.monitor.whenOnline(ID, new AbortController().signal);
    assert.ok(Date.now() - started < 200);
  });

  test("whenOnline() resolves when the device comes online", async (t) => {
    const r = await rig(t, { init: { hangDevice: true } });
    r.monitor.start();
    let resolved = false;
    const waiting = r.monitor
      .whenOnline(ID, new AbortController().signal)
      .then(() => (resolved = true));
    await delay(200);
    assert.equal(resolved, false, "still waiting while the probe hangs");
    r.stub.hangDevice = false;
    r.monitor.check(ID);
    await waiting;
    assert.equal(r.status(), "online");
  });

  test("whenOnline() returns when its signal aborts, even if the device never comes online", async (t) => {
    const r = await rig(t, { token: null });
    r.monitor.start();
    await r.waitFor("unauthorized");
    const abort = new AbortController();
    const waiting = r.monitor.whenOnline(ID, abort.signal);
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    await waiting;
    assert.ok(Date.now() - started < 2000);
    assert.notEqual(r.status(), "online");
  });
});
