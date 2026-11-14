// The Vue client's app state (store.ts): selection, the tree, derived views, boot and saved UI
// state. Run under Node against a fake EventSource and a fake fetch (see client-env.ts).
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkDevice } from "../../dpi-sdk/src/api.js";
import { FakeEventSource, type FetchCall, type FetchReply } from "./client-env.js";
import {
  B,
  T,
  agentOf,
  browser,
  dev,
  fetched,
  m,
  modelInfo,
  network,
  nextTick,
  open,
  resetClient,
  snapshot,
  taskOf,
  teardownClient,
  toast,
  usage,
} from "./client-fixture.js";
import { delay, until } from "./support.js";

after(teardownClient);
beforeEach(resetClient);

describe("select and the tree", () => {
  test("selecting an agent that is in the tree expands its device, session and agent", () => {
    network([dev([agentOf(1)])]);
    m.store.ui.drawer = true;
    m.store.select(T);
    assert.deepEqual(m.store.selected.value, T);
    assert.equal(m.store.ui.drawer, false, "the narrow-screen drawer closes");
    assert.deepEqual([...m.store.expanded.value].sort(), ["dev", "dev/s/s1", "dev/s/s1/a/1"]);
  });

  test("a fork or subagent opens every ancestor too", () => {
    network([
      dev([
        agentOf(1),
        agentOf(2, { kind: "fork", parentId: 1 }),
        agentOf(3, { kind: "subagent", ownerAgentId: 2 }),
      ]),
    ]);
    m.store.select({ ...T, agentId: 3 });
    for (const id of [1, 2, 3])
      assert.ok(m.store.expanded.value.has(`dev/s/s1/a/${id}`), `agent ${id}`);
  });

  test("a parent loop in the tree does not hang the reveal", () => {
    network([dev([agentOf(1, { parentId: 2 }), agentOf(2, { parentId: 1 })])]);
    m.store.select(T);
    assert.ok(m.store.expanded.value.has("dev/s/s1/a/2"));
  });

  test("an agent that has not reached the tree yet opens its own rows now and its parents when it appears", async () => {
    network([dev([agentOf(1)])]);
    m.store.select({ ...T, agentId: 5 });
    assert.ok(!m.store.expanded.value.has("dev/s/s1/a/1"));
    assert.ok(m.store.expanded.value.has("dev/s/s1/a/5"), "its own rows are open already");
    network([dev([agentOf(1), agentOf(5, { kind: "fork", parentId: 1 })])]);
    await nextTick();
    assert.ok(
      m.store.expanded.value.has("dev/s/s1/a/1"),
      "the parent opens once the fork shows up",
    );
  });

  test("once the agent has been found the tree is left alone, so a row the user closed stays closed", async () => {
    network([dev([agentOf(1), agentOf(2, { parentId: 1 })])]);
    m.store.select({ ...T, agentId: 2 });
    m.store.toggle("dev/s/s1/a/1", false);
    network([dev([agentOf(1), agentOf(2, { parentId: 1 })])]);
    await nextTick();
    assert.ok(!m.store.expanded.value.has("dev/s/s1/a/1"));
  });

  test("select(undefined) clears the selection and everything derived from it", async () => {
    await open();
    m.store.select(undefined);
    await nextTick();
    assert.equal(m.store.selected.value, undefined);
    assert.equal(m.store.deviceId.value, undefined);
    assert.equal(m.store.agentHandle.value, undefined);
    assert.equal(m.store.sessionHandle.value, undefined);
    assert.equal(m.store.client.value, undefined);
  });

  test("toggle() flips a key, or forces it open or closed", () => {
    const { toggle, expanded } = m.store;
    toggle("k");
    assert.ok(expanded.value.has("k"));
    toggle("k");
    assert.ok(!expanded.value.has("k"));
    toggle("k", true);
    toggle("k", true);
    assert.ok(expanded.value.has("k"));
    toggle("k", false);
    toggle("k", false);
    assert.ok(!expanded.value.has("k"));
  });

  test("toggle() replaces the set, so Vue sees the change", () => {
    const before = m.store.expanded.value;
    m.store.toggle("x", true);
    assert.notEqual(m.store.expanded.value, before);
    assert.equal(before.has("x"), false, "the old set is untouched");
  });

  test("the handles point at the device through the hub proxy", async () => {
    await open();
    assert.equal(m.store.client.value!.baseUrl, "/api/devices/dev");
    assert.equal(m.store.agentHandle.value!.base, "/v1/sessions/s1/agents/1");
    assert.equal(m.store.sessionHandle.value!.base, "/v1/sessions/s1");
  });
});

describe("derived state", () => {
  test("device, online and sessionSummary follow the network and the selection", async () => {
    await open([agentOf(1)]);
    assert.equal(m.store.device.value?.id, "dev");
    assert.equal(m.store.online.value, true);
    assert.equal(m.store.sessionSummary.value?.name, "Work");
    network([dev([agentOf(1)], { status: "offline" })]);
    assert.equal(m.store.online.value, false);
    assert.equal(m.store.sessionSummary.value?.name, "Work", "the cached tree still answers");
  });

  test("models and currentModel come from the device info and the agent's snapshot", async () => {
    const o = await open([agentOf(1)], {
      info: { models: [modelInfo("a"), modelInfo("b", "b.png")] } as never,
    });
    assert.deepEqual(
      m.store.models.value.map((x) => x.id),
      ["a", "b"],
    );
    assert.equal(m.store.currentModel.value, undefined, "no snapshot yet");
    o.agent(snapshot({ agent: { model: { provider: "faux", modelId: "b" } } }));
    assert.equal(m.store.currentModel.value?.id, "b");
    o.agent(snapshot({ agent: { model: { provider: "other", modelId: "b" } } }));
    assert.equal(m.store.currentModel.value, undefined, "provider must match too");
  });

  test("sessionAgents prefers the live session feed and falls back to the tree", async () => {
    const o = await open([agentOf(1), agentOf(2)]);
    assert.deepEqual(
      m.store.sessionAgents.value.map((a) => a.id),
      [1, 2],
    );
    o.session({
      type: "session",
      agents: [agentOf(1), agentOf(2), agentOf(3)],
      tasks: [],
      usage: { models: {}, tools: {} },
    });
    assert.deepEqual(
      m.store.sessionAgents.value.map((a) => a.id),
      [1, 2, 3],
    );
    assert.equal(m.store.agentSummary.value?.id, 1);
  });

  test("activeLineage runs from the root to the selected agent", async () => {
    const agents = [agentOf(1), agentOf(2, { kind: "fork", parentId: 1 })];
    const o = await open(agents);
    m.store.select({ ...T, agentId: 2 });
    await nextTick();
    o.session({ type: "session", agents, tasks: [], usage: { models: {}, tools: {} } });
    assert.deepEqual(
      m.store.activeLineage.value.map((a) => a.id),
      [1, 2],
    );
    m.store.select(undefined);
    assert.deepEqual(m.store.activeLineage.value, []);
  });

  test("tasks gathers this agent's and its subagents' tasks, transitively, and marks inherited background", async () => {
    const agents = [
      agentOf(1),
      agentOf(2, { kind: "subagent", ownerAgentId: 1, ownerTaskId: 20 }),
      agentOf(3, { kind: "subagent", ownerAgentId: 2, ownerTaskId: 30 }),
      agentOf(9), // unrelated agent in the same session
    ];
    const o = await open(agents);
    o.session({
      type: "session",
      agents,
      usage: { models: {}, tools: {} },
      tasks: [
        taskOf(10, 1),
        taskOf(20, 1, { background: true }),
        taskOf(30, 2),
        taskOf(40, 3),
        taskOf(90, 9),
      ],
    });
    const tasks = m.store.tasks.value;
    assert.deepEqual(
      tasks.map((t) => t.id),
      [10, 20, 30, 40],
      "the other agent's task is left out",
    );
    const bg = Object.fromEntries(tasks.map((t) => [t.id, t.effectiveBackground]));
    assert.deepEqual(
      bg,
      { 10: false, 20: true, 30: true, 40: true },
      "30 runs under background task 20 (via agent 2), and 40 under 30",
    );
  });

  test("tasks is empty with nothing selected, and survives an owner loop", async () => {
    assert.deepEqual(m.store.tasks.value, []);
    const agents = [agentOf(1, { ownerAgentId: 1 })];
    const o = await open(agents);
    o.session({
      type: "session",
      agents,
      tasks: [taskOf(1, 1, { owner: 1 })],
      usage: { models: {}, tools: {} },
    });
    assert.equal(m.store.tasks.value.length, 1);
  });

  test("busy is true while the agent runs or a foreground task is its own, but not for a background task", async () => {
    const agents = [agentOf(1)];
    const o = await open(agents);
    o.agent(snapshot());
    o.session({ type: "session", agents, tasks: [], usage: { models: {}, tools: {} } });
    assert.equal(m.store.busy.value, false);
    o.session({ type: "tasks", tasks: [taskOf(1, 1, { background: true })] });
    assert.equal(m.store.busy.value, false, "a background job does not make the agent busy");
    o.session({ type: "tasks", tasks: [taskOf(2, 1)] });
    assert.equal(m.store.busy.value, true);
    o.session({ type: "tasks", tasks: [] });
    o.agent(snapshot({ run: { inputs: [1] } }));
    assert.equal(m.store.busy.value, true, "a running agent is busy");
  });

  test("usage totals the agent's model usage", async () => {
    const o = await open();
    o.agent(snapshot({ usage: { models: { a: usage(100), b: usage(250) }, tools: {} } }));
    assert.equal(m.store.usage.value.tokens, 350);
    assert.equal(m.store.usage.value.cost, 1);
  });
});

describe("boot", () => {
  const handler =
    (options: {
      devices?: NetworkDevice[];
      selected?: unknown;
      width?: unknown;
      panels?: unknown;
      configFile?: string;
      fail?: boolean;
    }) =>
    (call: FetchCall): FetchReply => {
      if (options.fail) return { status: 502, statusText: "Bad Gateway", raw: "" };
      if (call.url === "/api/network")
        return { body: { configFile: options.configFile, devices: options.devices ?? [] } };
      const key = /^\/api\/ui-state\/(.+)$/.exec(call.url)?.[1];
      if (call.method === "GET" && key)
        return {
          body: {
            value:
              {
                "tree.selected": options.selected,
                "tree.width": options.width,
                "layout.panels": options.panels,
              }[key] ?? null,
          },
        };
      return {};
    };

  test("it reads the network and the saved UI state, applies them and starts the stream", async () => {
    const streams = FakeEventSource.instances.length;
    browser.fetch.handler = handler({
      devices: [dev([agentOf(1), agentOf(2)])],
      configFile: "/x/dpi-network.yaml",
      selected: { ...T, agentId: 2 },
      width: 412,
      panels: { tree: false, inspector: true },
    });
    await m.store.boot();
    assert.equal(FakeEventSource.instances.length, streams + 1, "a stream was started");
    assert.deepEqual(
      browser.fetch.calls
        .filter((c) => c.method === "GET" && !c.url.startsWith("/api/devices/"))
        .map((c) => c.url)
        .sort(),
      [
        "/api/network",
        "/api/ui-state/layout.panels",
        "/api/ui-state/tree.selected",
        "/api/ui-state/tree.width",
      ],
    );
    assert.equal(m.store.configFile.value, "/x/dpi-network.yaml");
    assert.equal(m.store.treeWidth.value, 412);
    assert.equal(m.store.layout.tree, false);
    assert.deepEqual(m.store.selected.value, { ...T, agentId: 2 });
    assert.equal(m.store.network.devices.value[0].id, "dev");
    assert.ok(m.store.expanded.value.has("dev/s/s1/a/2"), "the saved selection is revealed");
    assert.equal(m.store.ui.error, "");
  });

  test("a stored selection of a device that no longer exists is ignored for the first online root agent", async () => {
    browser.fetch.handler = handler({
      devices: [dev([agentOf(1, { kind: "fork", parentId: 7 }), agentOf(7)])],
      selected: { deviceId: "gone", sessionId: "s", agentId: 1 },
    });
    await m.store.boot();
    assert.deepEqual(
      m.store.selected.value,
      { ...T, agentId: 7 },
      "the root agent, not just the first one",
    );
  });

  test("with nothing saved it opens the root agent of the first online device that has a session", async () => {
    browser.fetch.handler = handler({
      devices: [
        dev([agentOf(1)], { status: "offline" }, "off"),
        { ...dev([], {}, "empty"), tree: { uid: "u", name: "empty", at: 1, sessions: [] } },
        dev([agentOf(3, { kind: "fork", parentId: 4 }), agentOf(4)], {}, "dev"),
      ],
    });
    await m.store.boot();
    assert.deepEqual(m.store.selected.value, { deviceId: "dev", sessionId: "s1", agentId: 4 });
  });

  test("with no online device that has a session nothing is selected", async () => {
    browser.fetch.handler = handler({ devices: [dev([agentOf(1)], { status: "offline" })] });
    await m.store.boot();
    assert.equal(m.store.selected.value, undefined);
  });

  test("devices the stream delivered first are not overwritten by the slower REST answer", async () => {
    network([dev([agentOf(1)], {}, "streamed")]);
    browser.fetch.handler = handler({ devices: [dev([agentOf(1)], {}, "rest")] });
    await m.store.boot();
    assert.deepEqual(
      m.store.network.devices.value.map((d) => d.id),
      ["streamed"],
    );
  });

  test("a hub that cannot be reached leaves the error on screen and selects nothing", async () => {
    browser.fetch.handler = handler({ fail: true });
    await m.store.boot();
    assert.equal(m.store.ui.error, "502 Bad Gateway");
    assert.equal(m.store.selected.value, undefined);
  });

  test("after boot the selection is saved at once, and clearing it saves null", async () => {
    browser.fetch.handler = handler({});
    await m.store.boot();
    browser.fetch.reset();
    m.store.select(T);
    await until(
      () => fetched("PUT", "/api/ui-state/tree.selected").length === 1,
      2000,
      "selection saved",
    );
    assert.deepEqual(fetched("PUT", "/api/ui-state/tree.selected")[0].body, { value: T });
    m.store.select(undefined);
    await until(() => fetched("PUT", "/api/ui-state/tree.selected").length === 2, 2000, "cleared");
    assert.deepEqual(fetched("PUT", "/api/ui-state/tree.selected")[1].body, { value: null });
  });

  test("the tree width and panel layout are saved after a pause, once per burst", async () => {
    browser.fetch.handler = handler({});
    await m.store.boot();
    await delay(400); // let saves queued by the previous test's reset go out first
    browser.fetch.reset();
    for (const width of [350, 360, 370]) {
      m.store.treeWidth.value = width;
      await nextTick();
    }
    assert.equal(fetched("PUT", "/api/ui-state/tree.width").length, 0, "debounced");
    await until(() => fetched("PUT", "/api/ui-state/tree.width").length === 1, 2000, "saved");
    await delay(400);
    assert.deepEqual(
      fetched("PUT", "/api/ui-state/tree.width").map((c) => c.body),
      [{ value: 370 }],
    );
    m.store.layout.inspector = false;
    await until(
      () => fetched("PUT", "/api/ui-state/layout.panels").length === 1,
      2000,
      "layout saved",
    );
    assert.deepEqual(fetched("PUT", "/api/ui-state/layout.panels")[0].body, {
      value: { tree: true, inspector: false },
    });
  });

  test("a failed save is swallowed", async () => {
    browser.fetch.handler = handler({});
    await m.store.boot();
    browser.fetch.handler = () => ({ status: 500, raw: "no" });
    m.store.select(T);
    await delay(100);
    assert.equal(m.store.ui.error, "", "nothing is shown for a failed save");
  });
});

describe("agent detail", () => {
  const detail = (name: string) => ({
    id: 1,
    name,
    sessionId: "s1",
    config: {},
    tools: [],
    extensions: [],
  });

  test("it is fetched when an agent is selected on an online device", async () => {
    browser.fetch.handler = (c) => (c.url === `${B}/agents/1` ? { body: detail("one") } : {});
    await open();
    await until(() => m.store.detail.value?.name === "one", 3000, "detail");
    assert.equal(fetched("GET", `${B}/agents/1`).length, 1);
  });

  test("it is cleared when the device goes offline", async () => {
    browser.fetch.handler = () => ({ body: detail("one") });
    await open([agentOf(1)]);
    await until(() => m.store.detail.value !== undefined, 3000, "detail");
    network([dev([agentOf(1)], { status: "offline" })]);
    await until(() => m.store.detail.value === undefined, 3000, "cleared");
  });

  test("a failed fetch clears it", async () => {
    browser.fetch.handler = () => ({ body: detail("one") });
    await open();
    await until(() => m.store.detail.value !== undefined, 3000, "detail");
    browser.fetch.handler = () => ({
      status: 500,
      body: { error: { code: "internal", message: "x" } },
    });
    await m.store.refreshDetail();
    assert.equal(m.store.detail.value, undefined);
  });

  test("when two fetches overlap the later one wins, even if it answers first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    browser.fetch.handler = async () => {
      if (++n === 1) {
        await gate;
        return { body: detail("slow, older") };
      }
      return { body: detail("fast, newer") };
    };
    await open();
    await until(() => n >= 1, 2000, "first fetch started");
    await m.store.refreshDetail();
    assert.equal(m.store.detail.value?.name, "fast, newer");
    release();
    await delay(50);
    assert.equal(m.store.detail.value?.name, "fast, newer", "the stale answer is dropped");
  });
});

describe("a session archived on its device", () => {
  const noSessions = (status: NetworkDevice["status"] = "online") => ({
    ...dev([agentOf(1)], { status }),
    tree: { uid: "u", name: "dev", at: 2, sessions: [] },
  });

  test("a not-found fault for a session that left the tree notifies and deselects", async () => {
    const o = await open([agentOf(1)]);
    network([noSessions()]);
    o.agent({ type: "fault", error: { code: "not_found", message: "no such session" } });
    await until(() => m.store.selected.value === undefined, 2000, "deselected");
    assert.equal(toast(), "That session was archived on its device.");
  });

  test("a fault for a session that is still in the tree is left alone", async () => {
    const o = await open([agentOf(1)]);
    o.agent({ type: "fault", error: { code: "not_found", message: "no such agent" } });
    await delay(50);
    assert.deepEqual(m.store.selected.value, T);
    assert.equal(toast(), "");
  });

  test("a fault while the device is offline is not read as an archive", async () => {
    const o = await open([agentOf(1)]);
    network([noSessions("offline")]);
    o.agent({ type: "fault", error: { code: "not_found", message: "x" } });
    await delay(50);
    assert.deepEqual(m.store.selected.value, T);
  });
});
