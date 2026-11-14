// An in-process fake dpi-backend for tests: just enough of the v1 API for dpi-tui, over real HTTP and SSE,
// so the real DpiClient (and everything above it) runs unchanged. Free, offline, deterministic.
// It does not check who is asking; a test that needs a rejection queues one with `injections`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type {
  AgentSummary,
  DeviceInfo,
  DirListing,
  Frame,
  InboxItem,
  ModelInfo,
  SessionSummary,
  WireSnapshotEvent,
} from "../../../dpi-sdk/src/api.ts";

export const MODELS: ModelInfo[] = [
  { id: "alpha-1", provider: "faux", name: "Alpha One", tier: "fast", icon: "a", contextWindow: 1000, reasoning: false, cost: { input: 0, output: 0 } },
  { id: "beta-2", provider: "faux", name: "Beta Two", tier: "smart", icon: "b", contextWindow: 200_000, reasoning: true, cost: { input: 1, output: 2 } },
];

export const deviceInfo = (extra: Partial<DeviceInfo> = {}): DeviceInfo => ({
  uid: "uid-1",
  name: "fake",
  hostname: "fake-host",
  platform: "linux",
  apiVersion: 1,
  durableVersion: "0.0.0",
  startedAt: 0,
  startDirs: ["/work"],
  models: MODELS,
  defaultModel: "beta-2",
  storage: { dataDir: "/data", catalogPath: "/data/catalog.sqlite", appStatePath: "/data/app-state.sqlite" },
  capabilities: ["events"],
  ...extra,
});

export const agent = (id: number, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id === 1 ? "Main" : `Agent ${id}`,
  named: false,
  kind: id === 1 ? "root" : "fork",
  busy: false,
  background: 0,
  ...extra,
});

export const session = (id: string, name: string, agents: AgentSummary[] = [agent(1)], extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  name,
  cwd: `/home/u/work/${name}`,
  model: "faux/beta-2",
  createdAt: 0,
  dbPath: `/data/${id}/agent.sqlite`,
  busy: false,
  agents,
  ...extra,
});

export interface RecordedRequest {
  method: string;
  /** Path with query string. */
  path: string;
  body?: any;
  idempotencyKey?: string;
}

export interface Injection {
  match: (request: RecordedRequest) => boolean;
  /** Reply with this HTTP status and error code, or drop the connection (the client sees "offline"). */
  status?: number;
  code?: string;
  message?: string;
  destroy?: boolean;
}

const emptySnapshot = (extra: Partial<WireSnapshotEvent> = {}): WireSnapshotEvent => ({
  type: "snapshot",
  entries: [],
  tools: [],
  compactions: [],
  inbox: [],
  agent: { model: { provider: "faux", modelId: "beta-2" }, thinkingLevel: "low" },
  usage: { models: {}, tools: {} },
  ...extra,
});

export class FakeDevice {
  readonly requests: RecordedRequest[] = [];
  /** One-shot replies that win over the normal routes, consumed in order of match. */
  readonly injections: Injection[] = [];
  sessions: SessionSummary[] = [
    session("11111111-aaaa-4aaa-8aaa-111111111111", "triage", [
      agent(1),
      agent(2, { name: "alt-path", named: true, kind: "fork", parentId: 1, forkedAt: 5 }),
      agent(3, { name: "helper", kind: "subagent", ownerAgentId: 1, background: 1 }),
    ]),
    session("22222222-bbbb-4bbb-8bbb-222222222222", "review", [agent(1, { busy: true })], { busy: true }),
  ];
  info: DeviceInfo = deviceInfo();
  /** Directory tree for GET /v1/fs/dirs, keyed by path ("" is the start dirs). */
  dirs: Record<string, DirListing> = {
    "": { path: "", dirs: [{ name: "work", path: "/work" }] },
    "/work": { path: "/work", parent: "", dirs: [{ name: "app", path: "/work/app" }] },
    "/work/app": { path: "/work/app", parent: "/work", dirs: [] },
  };
  agentSnapshot: WireSnapshotEvent = emptySnapshot();
  /** Inbox items sent with the snapshot of an agent stream. */
  agentInbox: InboxItem[] = [];
  sessionFrames: Frame[] = [];
  private server: Server;
  private sockets = new Set<Socket>();
  private agentStreams = new Set<ServerResponse>();
  private sessionStreams = new Set<ServerResponse>();
  url = "";

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    for (const res of [...this.agentStreams, ...this.sessionStreams]) res.end();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Requests whose "METHOD path" starts with `prefix`. */
  seen(prefix: string) {
    return this.requests.filter((r) => `${r.method} ${r.path}`.startsWith(prefix));
  }

  /** Push a frame to every open agent (or session) stream. */
  pushAgent(frame: Frame) {
    for (const res of this.agentStreams) send(res, frame);
  }
  pushSession(frame: Frame) {
    for (const res of this.sessionStreams) send(res, frame);
  }
  get openAgentStreams() {
    return this.agentStreams.size;
  }
  get openSessionStreams() {
    return this.sessionStreams.size;
  }

  private find(ref: string) {
    return this.sessions.find((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase());
  }
  private findAgent(s: SessionSummary, ref: string) {
    if (ref === "main") return s.agents.find((a) => a.kind === "root");
    return s.agents.find((a) => String(a.id) === ref || a.name.toLowerCase() === ref.toLowerCase());
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url || "http://x");
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      body: text ? JSON.parse(text) : undefined,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined,
    };
    this.requests.push(record);

    const injection = this.injections.findIndex((i) => i.match(record));
    if (injection >= 0) {
      const [hit] = this.injections.splice(injection, 1);
      if (hit.destroy) return void req.socket.destroy();
      return error(res, hit.status ?? 500, hit.code ?? "internal", hit.message ?? "injected failure");
    }

    const path = url.pathname;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let m: RegExpMatchArray | null;
    if (path === "/v1/device") return json(this.info);
    if (path === "/v1/tree") return json({ uid: this.info.uid, name: this.info.name, sessions: this.sessions, at: 0 });
    if (path === "/v1/fs/dirs") {
      const listing = this.dirs[url.searchParams.get("path") ?? ""];
      return listing ? json(listing) : error(res, 404, "not_found", "no such directory");
    }
    if (path === "/v1/sessions" && record.method === "POST") {
      const body = record.body as { name: string; cwd: string; model: { provider: string; modelId: string } };
      const created = session(`33333333-cccc-4ccc-8ccc-${String(this.sessions.length).padStart(12, "0")}`, body.name, [agent(1)], {
        cwd: body.cwd,
        model: `${body.model.provider}/${body.model.modelId}`,
      });
      this.sessions.push(created);
      return json(created, 201);
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)$/))) {
      const s = this.find(decodeURIComponent(m[1]));
      return s ? json(s) : error(res, 404, "not_found", `No session ${decodeURIComponent(m[1])}`);
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)\/events$/))) {
      const s = this.find(decodeURIComponent(m[1]));
      if (!s) return error(res, 404, "not_found", "No session");
      return this.stream(res, this.sessionStreams, { type: "hello", apiVersion: 1, serverTime: 0, scope: { kind: "session", sessionId: s.id } }, [
        { type: "session", agents: s.agents, tasks: [], usage: { models: {}, tools: {} } },
        ...this.sessionFrames,
      ]);
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)\/agents$/)) && record.method === "POST") {
      const s = this.find(decodeURIComponent(m[1]));
      if (!s) return error(res, 404, "not_found", "No session");
      const body = (record.body ?? {}) as { name?: string };
      const created = agent(s.agents.length + 1, { name: body.name ?? `Agent ${s.agents.length + 1}`, named: !!body.name, kind: "fork", parentId: 1 });
      s.agents.push(created);
      return json(created, 201);
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)\/agents\/([^/]+)(\/.*)?$/))) {
      const s = this.find(decodeURIComponent(m[1]));
      const a = s && this.findAgent(s, decodeURIComponent(m[2]));
      if (!s || !a) return error(res, 404, "not_found", `No agent ${decodeURIComponent(m[2])}`);
      const rest = m[3] ?? "";
      if (rest === "" && record.method === "GET") return json({ ...a, sessionId: s.id, config: {}, tools: [], extensions: [] });
      if (rest === "/events")
        return this.stream(res, this.agentStreams, { type: "hello", apiVersion: 1, serverTime: 0, scope: { kind: "agent", sessionId: s.id, agentId: a.id } }, [
          { type: "snapshot", snapshot: this.agentSnapshot, inbox: this.agentInbox },
        ]);
      if (rest === "/messages") return json({ submissionId: 1, status: "queued" });
      if (rest === "/abort" || rest === "/reset") return json({ ok: true });
      if (rest === "/compact") return json({ taskId: 9 });
      if (rest === "/config") return json({ ...(record.body ?? {}) });
      if (rest === "/fork") {
        const created = agent(s.agents.length + 1, { name: record.body?.name ?? `Fork ${s.agents.length + 1}`, named: !!record.body?.name, kind: "fork", parentId: a.id, forkedAt: record.body?.entryId });
        s.agents.push(created);
        return json(created, 201);
      }
      if (rest === "" && record.method === "PATCH") {
        a.name = record.body.name;
        a.named = true;
        return json(a);
      }
    }
    return error(res, 404, "not_found", `fake device: ${record.method} ${record.path}`);
  }

  private stream(res: ServerResponse, set: Set<ServerResponse>, hello: Frame, frames: Frame[]) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send(res, hello);
    for (const frame of frames) send(res, frame);
    set.add(res);
    res.on("close", () => set.delete(res));
  }
}

function send(res: ServerResponse, frame: Frame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function error(res: ServerResponse, status: number, code: string, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}

export async function startFakeDevice() {
  return new FakeDevice().listen();
}

/** Wait a moment so fire-and-forget calls (`void app.attach(...)`) and stream frames land. */
export const settle = async (ms = 40) => {
  await new Promise((r) => setTimeout(r, ms));
};

export async function until(check: () => boolean, what: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
