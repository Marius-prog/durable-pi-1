// Shared helpers for the playground's unit tests. Everything here is local and offline: a stub
// device (a tiny HTTP server that speaks just enough of /v1), temp registries and ephemeral ports.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSse } from "../../dpi-sdk/src/sse.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import type { DeviceInfo, DeviceTree, Frame, MuxFrame } from "../../dpi-sdk/src/api.js";

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(
  fn: () => unknown | Promise<unknown>,
  timeout = 10_000,
  what = "condition",
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(25);
  }
  throw Error(`Timed out waiting for ${what}`);
}

export async function freePort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** A device-token shaped string (at least 32 characters, so the registry accepts it). */
export const newToken = () => `dpi_${randomBytes(32).toString("base64url")}`;

/** A temp directory plus a registry inside it. Never touches the real ~/.dpi. */
export function tempRegistry() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dpi-hub-test-")));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  return {
    dir,
    registry,
    cleanup: async () => {
      try {
        registry.close();
      } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function tempDir(prefix = "dpi-hub-test-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------ stub device

export interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface EventClient {
  url: string;
  res: ServerResponse;
}

/**
 * A fake dpi-backend. `GET /v1/device` and the three `/events` streams check the bearer token;
 * `/v1/echo/*` reflects the request; the rest are failure modes for the proxy tests.
 */
export class StubDevice {
  token = newToken();
  uid = `uid-${randomBytes(8).toString("hex")}`;
  name = "stub";
  apiVersion: number = 1;
  /** Force a status on GET /v1/device (for example 500). */
  deviceStatus?: number;
  /** Never answer GET /v1/device. */
  hangDevice = false;
  /** Force a failure on every /events stream, sent as `{ error: { code, message } }`. */
  eventsFailure?: { status: number; code: string; message: string };
  /** Limit `eventsFailure` to some stream urls (default: all of them). */
  failMatch?: (url: string) => boolean;
  /** Sent to a device-scope `/v1/events` stream right after hello. */
  tree?: DeviceTree;
  /** When false the stream ends right after hello. */
  keepStreamsOpen = true;
  hits: Hit[] = [];
  /** URLs of the /events streams currently open. */
  clients = new Set<EventClient>();
  /** Closed-by-client notices, in order: the url of each stream or request that was cut. */
  closedByClient: string[] = [];
  port = 0;
  private server?: Server;

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  hitsTo(prefix: string) {
    return this.hits.filter((h) => h.url.startsWith(prefix));
  }

  info(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: "stub-host",
      platform: "linux",
      apiVersion: this.apiVersion as 1,
      durableVersion: "0.0.0",
      startedAt: 1,
      startDirs: ["/tmp"],
      models: [],
      defaultModel: "",
      storage: { dataDir: "/x", catalogPath: "/x/c", appStatePath: "/x/a" },
      capabilities: ["events"],
    };
  }

  /** Send one frame to every open stream whose url matches (default: all). */
  push(frame: Frame, match: (url: string) => boolean = () => true) {
    for (const c of this.clients)
      if (match(c.url)) c.res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  /** End every open stream (or the ones whose url matches) from the device side. */
  endStreams(match: (url: string) => boolean = () => true) {
    for (const c of this.clients) if (match(c.url)) c.res.end();
  }

  /** The urls of the streams open right now. */
  openUrls() {
    return Array.from(this.clients, (c) => c.url);
  }

  async start(port = this.port) {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(port, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    this.clients.clear();
  }

  private authorized(req: IncomingMessage) {
    return (
      req.headers.authorization === `Bearer ${this.token}` &&
      req.headers["x-dpi-token"] === this.token
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? "/";
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const hit: Hit = {
      method: req.method ?? "GET",
      url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    this.hits.push(hit);
    const json = (status: number, body: unknown) =>
      void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!this.authorized(req))
      return json(401, { error: { code: "unauthorized", message: "bad token" } });

    if (url === "/v1/device") {
      if (this.hangDevice) {
        res.on("close", () => this.closedByClient.push(url));
        return;
      }
      if (this.deviceStatus)
        return json(this.deviceStatus, { error: { code: "internal", message: "boom" } });
      return json(200, this.info());
    }
    if (
      /^\/v1\/(events|sessions\/[^/]+\/events|sessions\/[^/]+\/agents\/[^/]+\/events)(\?|$)/.test(
        url,
      )
    ) {
      if (this.eventsFailure && (this.failMatch?.(url) ?? true))
        return json(this.eventsFailure.status, {
          error: { code: this.eventsFailure.code, message: this.eventsFailure.message },
        });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const hello: Frame = {
        type: "hello",
        apiVersion: 1,
        serverTime: Date.now(),
        scope: { kind: "device" } as never,
      };
      res.write(`data: ${JSON.stringify(hello)}\n\n`);
      if (url.startsWith("/v1/events") && this.tree)
        res.write(`data: ${JSON.stringify({ type: "tree", tree: this.tree } satisfies Frame)}\n\n`);
      if (!this.keepStreamsOpen) return void res.end();
      const client: EventClient = { url, res };
      this.clients.add(client);
      res.on("close", () => {
        this.clients.delete(client);
        this.closedByClient.push(url);
      });
      return;
    }
    if (url.startsWith("/v1/echo/")) {
      res.setHeader("x-stub", "yes");
      return json(200, { method: hit.method, url, headers: hit.headers, body: hit.body });
    }
    if (url === "/v1/text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("plain words");
      return;
    }
    if (url === "/v1/missing")
      return json(404, { error: { code: "not_found", message: "no such thing" } });
    if (url === "/v1/boom") return void req.socket.destroy();
    if (url === "/v1/hang") {
      req.on("close", () => this.closedByClient.push(url));
      res.on("close", () => this.closedByClient.push(url));
      return;
    }
    return json(404, { error: { code: "not_found", message: `stub has no ${url}` } });
  }
}

export async function stubDevice(init: Partial<StubDevice> = {}) {
  const stub = new StubDevice();
  Object.assign(stub, init);
  await stub.start(0);
  return stub;
}

// ------------------------------------------------------------------ http helpers

/** A request with a Host header of your choice (fetch cannot set one). */
export function rawRequest(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }>(
    (done, fail) => {
      const req = httpRequest(
        {
          host: u.hostname,
          port: u.port,
          path,
          method: options.method ?? "GET",
          headers: {
            ...(options.host !== undefined ? { host: options.host } : {}),
            ...options.headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (x) => (text += x));
          res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on("error", fail);
      req.end(options.body);
    },
  );
}

export const jsonBody = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ------------------------------------------------------------------ browser stream

/** What a browser tab sees on `GET /api/stream`. */
export async function openBrowserStream(base: string) {
  const stop = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: stop.signal });
  const frames: MuxFrame[] = [];
  let raw = "";
  let streamId = "";
  void (async () => {
    // readSse hides the raw text, so tee the body: one copy to parse, one to keep.
    const [a, b] = res.body!.tee();
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of b as unknown as AsyncIterable<Uint8Array>)
        raw += decoder.decode(chunk);
    })().catch(() => {});
    for await (const m of readSse(a)) {
      const frame = JSON.parse(m.data) as MuxFrame;
      frames.push(frame);
      if (frame.frame.type === "stream") streamId = frame.frame.streamId;
    }
  })().catch(() => {});
  await until(() => streamId, 5000, "stream id");
  return {
    streamId,
    frames,
    raw: () => raw,
    close: () => stop.abort(),
    framesFor: (sub: string, type?: string) =>
      frames.filter((f) => f.sub === sub && (type === undefined || f.frame.type === type)),
    put: (subs: unknown) => fetch(`${base}/api/stream/${streamId}`, jsonBody({ subs }, "PUT")),
  };
}

// ------------------------------------------------------------------ hub child process

/** Boot the real hub entry point (main.ts) as a child process on an ephemeral port. */
export async function bootHubProcess(options: {
  home: string;
  networkFile: string;
  env?: Record<string, string | undefined>;
  args?: string[];
  port?: number;
  /** Host to pass with --host (default: none, so the hub binds 127.0.0.1). */
  host?: string;
}) {
  const port = options.port ?? (await freePort());
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DPI_HUB_PORT;
  delete env.DPI_HUB_HOST;
  Object.assign(env, options.env, {
    DPI_HOME: options.home,
    DPI_NETWORK_FILE: options.networkFile,
    NODE_NO_WARNINGS: "1",
  });
  const args = options.args ?? [
    "--port",
    String(port),
    ...(options.host ? ["--host", options.host] : []),
  ];
  let output = "";
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(import.meta.dirname, "../apps/dpi-playground-hub/src/main.ts"),
      ...args,
    ],
    {
      env: env as NodeJS.ProcessEnv,
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (output += x));
  child.stderr?.on("data", (x) => (output += x));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const base = `http://${options.host ?? "127.0.0.1"}:${port}`;
  return {
    port,
    base,
    child,
    exited,
    output: () => output,
    /** Resolve once the hub answers /api/network, or fail with its output if it exits first. */
    ready: async () => {
      for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw Error(`hub exited: ${output}`);
        try {
          const r = await rawRequest(base, "/api/network", { host: `127.0.0.1:${port}` });
          if (r.status === 200) return;
        } catch {}
        await delay(50);
      }
      throw Error(`hub did not start: ${output}`);
    },
    stop: async (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode === null) {
        child.kill(signal);
        await exited;
      }
      return child.exitCode;
    },
  };
}
