// The hub's entry point (main.ts) booted as a real process against stub devices: options, boot
// output, the routes it wires up, the guard in front of them, and shutdown. Every hub gets a temp
// DPI_HOME and its own DPI_NETWORK_FILE, so the real ~/.dpi and dpi-network.yaml are never read.
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import type { NetworkDevice } from "../../dpi-sdk/src/api.js";
import {
  bootHubProcess,
  delay,
  freePort,
  jsonBody,
  openBrowserStream,
  rawRequest,
  stubDevice,
  tempDir,
  until,
} from "./support.js";

/** Two stub devices, a YAML for them, and a booted hub. */
async function rig(
  t: TestContext,
  options: { host?: string; yaml?: (a: string, b: string) => string } = {},
) {
  const a = await stubDevice({ name: "box-a" });
  const b = await stubDevice({ name: "box-b" });
  const tmp = tempDir();
  const networkFile = join(tmp.dir, "dpi-network.yaml");
  const yaml =
    options.yaml?.(a.base, b.base) ??
    `devices:\n  box-a:\n    kind: url\n    url: ${a.base}\n    token_env: TOKEN_A\n  box-b:\n    kind: url\n    url: ${b.base}\n    token_env: TOKEN_B\n`;
  writeFileSync(networkFile, yaml);
  const home = join(tmp.dir, "home");
  const hub = await bootHubProcess({
    home,
    networkFile,
    env: { TOKEN_A: a.token, TOKEN_B: b.token },
    host: options.host,
  });
  t.after(async () => {
    await hub.stop();
    await a.stop();
    await b.stop();
    await tmp.cleanup();
  });
  await hub.ready();
  const get = (path: string, extra: Parameters<typeof rawRequest>[2] = {}) =>
    rawRequest(hub.base, path, { host: `127.0.0.1:${hub.port}`, ...extra });
  const network = async () =>
    JSON.parse((await get("/api/network")).text) as {
      configFile?: string;
      devices: NetworkDevice[];
    };
  const waitOnline = (id: string) =>
    until(
      async () => (await network()).devices.find((d) => d.id === id)?.status === "online",
      10_000,
      `${id} online`,
    );
  return { a, b, networkFile, home, hub, get, network, waitOnline, dir: tmp.dir };
}

describe("hub process: boot", () => {
  test("prints its address, registry, config file and devices", async (t) => {
    const r = await rig(t);
    const out = r.hub.output();
    assert.match(out, new RegExp(`Durable Pi hub: http://127\\.0\\.0\\.1:${r.hub.port}`));
    assert.ok(
      out.includes(`registry: ${join(r.home, "network.sqlite")}  config: ${r.networkFile}`),
      out,
    );
    assert.match(out, /devices: box-a, box-b/);
    assert.equal(out.includes("WARNING"), false, "a loopback hub does not warn");
    assert.ok(existsSync(join(r.home, "network.sqlite")), "the registry lives in DPI_HOME");
  });

  test("loads the devices from the YAML with tokens from the named variables, and never serves a token", async (t) => {
    const r = await rig(t);
    await r.waitOnline("box-a");
    await r.waitOnline("box-b");
    const body = await r.get("/api/network");
    const net = JSON.parse(body.text) as { configFile: string; devices: NetworkDevice[] };
    assert.equal(net.configFile, r.networkFile);
    assert.deepEqual(
      net.devices.map((d) => [d.id, d.kind, d.source, d.hasToken]),
      [
        ["box-a", "url", "config", true],
        ["box-b", "url", "config", true],
      ],
    );
    assert.equal(net.devices[0].info?.name, "box-a");
    assert.equal(body.text.includes(r.a.token) || body.text.includes(r.b.token), false);
    assert.equal(
      JSON.stringify(r.hub.output()).includes(r.a.token),
      false,
      "tokens are not logged either",
    );
    const stored = new NetworkRegistry(join(r.home, "network.sqlite"));
    try {
      assert.equal(stored.get("box-a")?.token, r.a.token, "the token is in the registry file");
    } finally {
      stored.close();
    }
  });

  test("a device whose token variable is unset starts as unauthorized with a hint", async (t) => {
    const tmp = tempDir();
    const stub = await stubDevice();
    const networkFile = join(tmp.dir, "dpi-network.yaml");
    writeFileSync(
      networkFile,
      `devices:\n  lone:\n    kind: url\n    url: ${stub.base}\n    token_env: DPI_TEST_UNSET_TOKEN_VAR\n`,
    );
    const hub = await bootHubProcess({
      home: join(tmp.dir, "h"),
      networkFile,
      env: { DPI_TEST_UNSET_TOKEN_VAR: undefined },
    });
    t.after(async () => {
      await hub.stop();
      await stub.stop();
      await tmp.cleanup();
    });
    await hub.ready();
    const get = () => rawRequest(hub.base, "/api/network", { host: `127.0.0.1:${hub.port}` });
    await until(
      async () => JSON.parse((await get()).text).devices[0].status === "unauthorized",
      8000,
      "unauthorized",
    );
    const [d] = JSON.parse((await get()).text).devices as NetworkDevice[];
    assert.equal(d.hasToken, false);
    assert.match(d.error!, /just net register lone/);
    assert.equal(stub.hits.length, 0);
  });

  test("an empty devices list boots fine and says none", async (t) => {
    const r = await rig(t, { yaml: () => "devices: {}\n" });
    assert.match(r.hub.output(), /devices: none/);
    assert.deepEqual((await r.network()).devices, []);
  });

  test("a broken YAML stops the hub with the reason", async (t) => {
    const tmp = tempDir();
    t.after(() => tmp.cleanup());
    const networkFile = join(tmp.dir, "dpi-network.yaml");
    writeFileSync(networkFile, "devices:\n  Bad_ID:\n    kind: url\n    url: http://127.0.0.1:1\n");
    const hub = await bootHubProcess({ home: join(tmp.dir, "h"), networkFile });
    const code = await hub.exited;
    assert.notEqual(code, 0);
    assert.match(hub.output(), /id must match/);
  });
});

describe("hub process: options", () => {
  test("--port needs a value", async (t) => {
    const tmp = tempDir();
    t.after(() => tmp.cleanup());
    const networkFile = join(tmp.dir, "dpi-network.yaml");
    writeFileSync(networkFile, "devices: {}\n");
    for (const args of [["--port"], ["--port", "--host", "127.0.0.1"]]) {
      const hub = await bootHubProcess({ home: join(tmp.dir, "h"), networkFile, args });
      const code = await hub.exited;
      assert.notEqual(code, 0, args.join(" "));
      assert.match(hub.output(), /--port needs a value/);
    }
  });

  test("DPI_HUB_PORT sets the port when --port is absent", async (t) => {
    const tmp = tempDir();
    t.after(() => tmp.cleanup());
    const networkFile = join(tmp.dir, "dpi-network.yaml");
    writeFileSync(networkFile, "devices: {}\n");
    const port = await freePort();
    const hub = await bootHubProcess({
      home: join(tmp.dir, "h"),
      networkFile,
      port,
      args: [],
      env: { DPI_HUB_PORT: String(port) },
    });
    t.after(() => hub.stop());
    await hub.ready();
    assert.match(hub.output(), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  });

  test("--port wins over DPI_HUB_PORT", async (t) => {
    const tmp = tempDir();
    t.after(() => tmp.cleanup());
    const networkFile = join(tmp.dir, "dpi-network.yaml");
    writeFileSync(networkFile, "devices: {}\n");
    const [envPort, argPort] = [await freePort(), await freePort()];
    const hub = await bootHubProcess({
      home: join(tmp.dir, "h"),
      networkFile,
      port: argPort,
      args: ["--port", String(argPort)],
      env: { DPI_HUB_PORT: String(envPort) },
    });
    t.after(() => hub.stop());
    await hub.ready();
    assert.match(hub.output(), new RegExp(`:${argPort}`));
  });

  test("a hub bound beyond loopback warns, and also answers to this machine's own names", async (t) => {
    // 127.0.0.2 is "not 127.0.0.1", so main.ts takes its non-loopback branch, yet stays on this machine.
    const r = await rig(t, { host: "127.0.0.2" });
    assert.match(
      r.hub.output(),
      /WARNING: the hub is listening on 127\.0\.0\.2\. Anyone who can reach it/,
    );
    const at = (host: string) => rawRequest(r.hub.base, "/api/network", { host });
    const port = r.hub.port;
    assert.equal((await at(`localhost:${port}`)).status, 200);
    assert.equal(
      (await at(`${hostname().toLowerCase()}:${port}`)).status,
      200,
      "the machine's hostname",
    );
    assert.equal((await at(`${hostname().toUpperCase()}:${port}`)).status, 200, "in any case");
    assert.equal(
      (
        await at(
          `${hostname()
            .toLowerCase()
            .replace(/\.local$/, "")}.local:${port}`,
        )
      ).status,
      200,
      "its .local name",
    );
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (lan)
      assert.equal((await at(`${lan}:${port}`)).status, 200, "an address of one of its interfaces");
    assert.equal((await at(`evil.test:${port}`)).status, 421);
    assert.equal(
      (await at(`${hostname().toLowerCase()}:${port + 1}`)).status,
      421,
      "the right name on another port",
    );
  });

  test("a loopback hub answers only to loopback names", async (t) => {
    const r = await rig(t);
    const at = (host: string) => rawRequest(r.hub.base, "/api/network", { host });
    const port = r.hub.port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
      assert.equal((await at(host)).status, 200, host);
    assert.equal((await at(`${hostname().toLowerCase()}:${port}`)).status, 421);
  });
});

describe("hub process: routes", () => {
  test("every /api route is behind the guard", async (t) => {
    const r = await rig(t);
    for (const [method, path] of [
      ["GET", "/api/network"],
      ["GET", "/api/ui-state/x"],
      ["GET", "/api/stream"],
      ["GET", "/api/nothing"],
    ] as const) {
      assert.equal(
        (await r.get(path, { method, host: "evil.test" })).status,
        421,
        `${method} ${path}`,
      );
      assert.equal(
        (await r.get(path, { method, headers: { origin: "http://evil.test" } })).status,
        403,
        `${method} ${path}`,
      );
    }
    assert.equal(
      (
        await r.get("/api/devices/box-a/check", {
          method: "POST",
          body: "x=1",
          headers: { "content-type": "text/plain" },
        })
      ).status,
      415,
    );
  });

  test("POST /api/devices/:id/check probes now and answers with the device", async (t) => {
    const r = await rig(t);
    await r.waitOnline("box-a");
    const res = await fetch(`${r.hub.base}/api/devices/box-a/check`, jsonBody({}));
    assert.equal(res.status, 200);
    const device = (await res.json()) as NetworkDevice;
    assert.equal(device.id, "box-a");
    assert.equal(device.status, "online");
    assert.equal(JSON.stringify(device).includes(r.a.token), false);
  });

  test("checking a device that fails reports the failure, not an error", async (t) => {
    const r = await rig(t);
    await r.waitOnline("box-b");
    r.b.deviceStatus = 500;
    const device = (await (
      await fetch(`${r.hub.base}/api/devices/box-b/check`, jsonBody({}))
    ).json()) as NetworkDevice;
    assert.equal(device.status, "offline");
    assert.equal(device.error, "boom");
  });

  test("checking an unknown device is 404 not_found", async (t) => {
    const r = await rig(t);
    const res = await fetch(`${r.hub.base}/api/devices/nope/check`, jsonBody({}));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: "not_found", message: "No device nope" } });
  });

  test("there are no device write routes: devices come from the YAML only", async (t) => {
    const r = await rig(t);
    for (const [method, path] of [
      ["POST", "/api/devices"],
      ["PUT", "/api/devices/box-a"],
      ["DELETE", "/api/devices/box-a"],
      ["PATCH", "/api/devices/box-a"],
      ["GET", "/api/devices"],
    ] as const) {
      const res = await fetch(
        `${r.hub.base}${path}`,
        method === "GET" || method === "DELETE"
          ? { method }
          : jsonBody({ id: "x", url: "http://x" }, method),
      );
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(await res.json(), {
        error: { code: "not_found", message: "API route not found" },
      });
    }
    assert.equal((await r.network()).devices.length, 2);
  });

  test("an unknown /api path is a JSON 404", async (t) => {
    const r = await rig(t);
    const res = await fetch(`${r.hub.base}/api/whatever/else`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });

  test("outside /api the built web UI is served, with index.html for any client-side route", async (t) => {
    // The UI comes from `npm run build`. Without a build the hub has nothing to send, and says 404.
    const index = resolve(import.meta.dirname, "../apps/dpi-playground-fe/dist/index.html");
    const r = await rig(t);
    for (const path of ["/", "/some/client/route"]) {
      const res = await fetch(`${r.hub.base}${path}`);
      if (existsSync(index)) {
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-type")!, /text\/html/);
        assert.match(await res.text(), /<div id="app"/);
      } else {
        assert.equal(res.status, 404, path);
        await res.arrayBuffer();
      }
    }
    assert.equal(
      (await fetch(`${r.hub.base}/api/nothing`)).headers.get("content-type")?.includes("json"),
      true,
    );
  });

  test("the proxy is mounted: the token is injected and streams are refused", async (t) => {
    const r = await rig(t);
    await r.waitOnline("box-a");
    const info = await (await fetch(`${r.hub.base}/api/devices/box-a/v1/device`)).json();
    assert.equal(info.name, "box-a");
    assert.equal(r.a.hitsTo("/v1/device").at(-1)!.headers.authorization, `Bearer ${r.a.token}`);
    assert.equal((await fetch(`${r.hub.base}/api/devices/box-a/v1/events`)).status, 400);
    assert.equal((await fetch(`${r.hub.base}/api/devices/ghost/v1/device`)).status, 404);
  });

  test("the mux is mounted: one stream carries the network and the subscribed device", async (t) => {
    const r = await rig(t);
    await r.waitOnline("box-a");
    const b = await openBrowserStream(r.hub.base);
    t.after(() => b.close());
    assert.equal((await b.put(["box-a/session/s1"])).status, 200);
    await until(() => b.framesFor("box-a/session/s1", "hello").length === 1, 8000, "session hello");
    assert.ok(b.framesFor("network").length >= 1);
    assert.equal((await b.put(["x"])).status, 400);
    assert.equal((await b.put(["ghost/device"])).status, 404);
    assert.equal(b.raw().includes(r.a.token), false);
  });
});

describe("hub process: UI state", () => {
  const put = (r: Awaited<ReturnType<typeof rig>>, key: string, body: unknown) =>
    fetch(`${r.hub.base}/api/ui-state/${key}`, jsonBody(body, "PUT"));
  const read = async (r: Awaited<ReturnType<typeof rig>>, key: string) =>
    (await (await fetch(`${r.hub.base}/api/ui-state/${key}`)).json()) as { value: unknown };

  test("an unset key reads as null", async (t) => {
    const r = await rig(t);
    assert.deepEqual(await read(r, "never-set"), { value: null });
  });

  test("a value round-trips as JSON, and the next PUT replaces it", async (t) => {
    const r = await rig(t);
    const value = { deviceId: "box-a", sessionId: "s1", agentId: 2, nested: [1, { a: "ü" }] };
    assert.deepEqual(await (await put(r, "tree.selected", { value })).json(), { ok: true });
    assert.deepEqual(await read(r, "tree.selected"), { value });
    await put(r, "tree.selected", { value: 300 });
    assert.deepEqual(await read(r, "tree.selected"), { value: 300 });
  });

  test("a missing or null value stores null", async (t) => {
    const r = await rig(t);
    await put(r, "k", { value: 5 });
    assert.equal((await put(r, "k", {})).status, 200);
    assert.deepEqual(await read(r, "k"), { value: null });
    await put(r, "k", { value: 5 });
    await put(r, "k", { value: null });
    assert.deepEqual(await read(r, "k"), { value: null });
  });

  test("keys are separate, and an encoded key is one key", async (t) => {
    const r = await rig(t);
    await put(r, "a", { value: 1 });
    await put(r, "b", { value: 2 });
    await put(r, "x%2Fy", { value: 3 });
    assert.deepEqual(
      [(await read(r, "a")).value, (await read(r, "b")).value, (await read(r, "x%2Fy")).value],
      [1, 2, 3],
    );
    assert.deepEqual(await read(r, "x"), { value: null });
  });

  test("a value over 100,000 characters is 400 invalid and is not stored", async (t) => {
    const r = await rig(t);
    const res = await put(r, "big", { value: "x".repeat(150_000) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid");
    assert.match(body.error.message, /too large/);
    assert.deepEqual(await read(r, "big"), { value: null });
  });

  test("a body over the 256kb limit is refused", async (t) => {
    const r = await rig(t);
    const res = await put(r, "huge", { value: "x".repeat(300_000) });
    assert.equal(res.status, 413);
  });

  test("a body that is not JSON is 400", async (t) => {
    const r = await rig(t);
    const res = await fetch(`${r.hub.base}/api/ui-state/k`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  test("UI state survives a hub restart", async (t) => {
    const r = await rig(t);
    await put(r, "layout.panels", { value: { tree: false, inspector: true } });
    assert.equal(await r.hub.stop(), 0);
    const again = await bootHubProcess({
      home: r.home,
      networkFile: r.networkFile,
      env: { TOKEN_A: r.a.token, TOKEN_B: r.b.token },
    });
    t.after(() => again.stop());
    await again.ready();
    const res = await rawRequest(again.base, "/api/ui-state/layout.panels", {
      host: `127.0.0.1:${again.port}`,
    });
    assert.deepEqual(JSON.parse(res.text), { value: { tree: false, inspector: true } });
  });
});

describe("hub process: registry and shutdown", () => {
  test("a device removed from the YAML is pruned at the next start, and a new one is added", async (t) => {
    const r = await rig(t);
    assert.deepEqual(
      (await r.network()).devices.map((d) => d.id),
      ["box-a", "box-b"],
    );
    await r.hub.stop();
    writeFileSync(
      r.networkFile,
      `devices:\n  box-b:\n    kind: url\n    url: ${r.b.base}\n    token_env: TOKEN_B\n  box-c:\n    kind: url\n    url: ${r.a.base}\n    token_env: TOKEN_A\n`,
    );
    const again = await bootHubProcess({
      home: r.home,
      networkFile: r.networkFile,
      env: { TOKEN_A: r.a.token, TOKEN_B: r.b.token },
    });
    t.after(() => again.stop());
    await again.ready();
    const res = await rawRequest(again.base, "/api/network", { host: `127.0.0.1:${again.port}` });
    assert.deepEqual(
      (JSON.parse(res.text).devices as NetworkDevice[]).map((d) => d.id),
      ["box-b", "box-c"],
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const)
    test(`${signal} shuts the hub down cleanly (exit 0), closing streams and saving device state`, async (t) => {
      const r = await rig(t);
      await r.waitOnline("box-a");
      const b = await openBrowserStream(r.hub.base);
      await b.put(["box-a/session/s1"]);
      await until(() => r.a.clients.size >= 2, 5000, "monitor and mux streams open on box-a");
      const exited = await r.hub.stop(signal);
      assert.equal(exited, 0);
      await until(() => r.a.clients.size === 0, 5000, "all upstream streams closed");
      const stored = new NetworkRegistry(join(r.home, "network.sqlite"));
      try {
        assert.equal(stored.get("box-a")?.lastStatus, "online", "the last status is on disk");
      } finally {
        stored.close();
      }
      await delay(50);
    });

  test("a signal while the hub is already closing does nothing more", async (t) => {
    const r = await rig(t);
    r.hub.child.kill("SIGTERM");
    r.hub.child.kill("SIGTERM");
    assert.equal(await r.hub.exited, 0);
  });
});
