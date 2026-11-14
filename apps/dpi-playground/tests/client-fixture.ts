// A loaded client (store, commands, jobs) with fake browser globals, plus builders for the
// network, agents and mux frames. Importing this file loads the client once per test process.
import type {
  AgentSummary,
  Frame,
  ModelInfo,
  NetworkDevice,
  TaskNode,
} from "../../dpi-sdk/src/api.js";
import { FakeEventSource, installBrowser, loadClient } from "./client-env.js";

export const browser = installBrowser();
export const m = await loadClient();
browser.attachDocument();
m.store.stream.start();
FakeEventSource.latest.hello("s1");

/** The agent most tests select. */
export const T = { deviceId: "dev", sessionId: "s1", agentId: 1 };
export const AGENT_KEY = (id = 1) => `dev/agent/s1/${id}?docs=demo.job-runs,demo.workspace`;
export const SESSION_KEY = "dev/session/s1";
/** URL prefix of the selected session through the hub's proxy. */
export const B = "/api/devices/dev/v1/sessions/s1";

export const FES = () => FakeEventSource.latest;
export const nextTick = () => m.vue.nextTick();
export const toast = () => m.store.ui.toast;
export const fetched = (method: string, url: string | RegExp) => browser.fetch.to(method, url);

export const agentOf = (id: number, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: `Agent ${id}`,
  named: false,
  kind: "root",
  busy: false,
  background: 0,
  ...extra,
});

export const modelInfo = (id: string, icon = "x.png"): ModelInfo => ({
  id,
  provider: "faux",
  name: id,
  tier: "t",
  icon,
  contextWindow: 1000,
  reasoning: false,
  cost: { input: 0, output: 0 },
});

/** A device with one session ("s1") holding `agents`. */
export const dev = (
  agents: AgentSummary[],
  extra: Partial<NetworkDevice> = {},
  id = "dev",
): NetworkDevice => ({
  id,
  name: id,
  kind: "url",
  url: "http://x",
  source: "config",
  hasToken: true,
  status: "online",
  tree: {
    uid: "u",
    name: id,
    at: 1,
    sessions: [
      {
        id: "s1",
        name: "Work",
        cwd: "/w",
        model: "m",
        createdAt: 1,
        dbPath: "/d",
        busy: false,
        agents,
      },
    ],
  },
  ...extra,
});

export const network = (devices: NetworkDevice[]) =>
  m.store.network.model.apply({ type: "network", devices });

export const taskOf = (
  id: number,
  conversationId: number,
  extra: Partial<TaskNode> = {},
): TaskNode => ({
  id,
  kind: "pi.tool",
  conversationId,
  background: false,
  state: { status: "running" },
  conversations: [],
  ...extra,
});

export const usage = (tokens: number) => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens,
  cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
});

export const snapshot = (overrides: Record<string, unknown> = {}): Frame => ({
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

/** Select the default target, let the feeds subscribe, and return senders for its two feeds. */
export async function open(agents = [agentOf(1)], extra: Partial<NetworkDevice> = {}) {
  network([dev(agents, extra)]);
  m.store.select(T);
  await nextTick();
  return {
    agent: (frame: Frame, id = 1) => FES().send(AGENT_KEY(id), frame),
    session: (frame: Frame) => FES().send(SESSION_KEY, frame),
  };
}

/** Put the store back to a blank slate. Call from beforeEach. */
export async function resetClient() {
  const s = m.store;
  s.select(undefined);
  await nextTick();
  network([]);
  await nextTick();
  s.expanded.value = new Set();
  Object.assign(s.ui, {
    error: "",
    toast: "",
    drawer: false,
    inspectorOverlay: false,
    tab: "session",
    composer: "",
    dialog: undefined,
  });
  Object.assign(s.layout, { tree: true, inspector: true });
  s.interrupting.value = false;
  browser.media.change(false);
  browser.fetch.reset();
  browser.document.queries.length = 0;
}

export async function teardownClient() {
  m.store.stream.stop();
  await m.unload();
  browser.restore();
}
