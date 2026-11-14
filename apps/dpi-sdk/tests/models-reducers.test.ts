import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentModel,
  NetworkModel,
  SessionModel,
  agentKey,
  agentLabel,
  agentTree,
  applyMessageChange,
  deviceKey,
  lineage,
  networkTree,
  sessionKey,
} from "../src/models.js";
import type {
  AgentSummary,
  Frame,
  NetworkDevice,
  SessionSummary,
  TaskNode,
  WireAgentEvent,
  WireAssistantMessage,
  WireEntry,
  WireSnapshotEvent,
  WireUsage,
} from "../src/api.js";

const usage: WireUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (content: WireAssistantMessage["content"] = []): WireAssistantMessage => ({
  role: "assistant",
  content,
  provider: "p",
  model: "m",
  usage,
  stopReason: "stop",
});
const snap = (extra: Partial<WireSnapshotEvent> = {}): WireSnapshotEvent => ({
  type: "snapshot",
  entries: [],
  tools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  ...extra,
});
const batch = (...events: WireAgentEvent[]): Frame => ({ type: "batch", events });
const userEntry = (id: number, text: string): WireEntry => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text }] });
const agentSummary = (id: number, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: `A${id}`,
  named: false,
  kind: "root",
  busy: false,
  background: 0,
  ...extra,
});

// ------------------------------------------------------------------ applyMessageChange

test("applyMessageChange: start and block changes place a copy at the content index", () => {
  const base = message();
  const block = { type: "text" as const, text: "hi" };
  const started = applyMessageChange(base, { type: "text_start", contentIndex: 0, block });
  assert.deepEqual(started.content, [block]);
  assert.notEqual(started.content[0], block, "the block is cloned, not shared");
  assert.deepEqual(base.content, [], "the previous message is untouched");
  const replaced = applyMessageChange(started, { type: "block", contentIndex: 0, block: { type: "thinking", thinking: "x" } });
  assert.deepEqual(replaced.content, [{ type: "thinking", thinking: "x" }]);
  const tool = applyMessageChange(base, { type: "toolcall_start", contentIndex: 2, block: { type: "toolCall", id: "c", name: "bash", arguments: {} } });
  assert.equal(tool.content.length, 3, "a start at a later index leaves holes before it");
  assert.equal(tool.content[2].type, "toolCall");
});

test("applyMessageChange: a message change replaces the whole message with a clone", () => {
  const next = message([{ type: "text", text: "final" }]);
  const out = applyMessageChange(message(), { type: "message", message: next });
  assert.deepEqual(out, next);
  assert.notEqual(out, next);
});

test("applyMessageChange: text and thinking deltas append, and restart a block of another type", () => {
  let m = applyMessageChange(message(), { type: "text_delta", contentIndex: 0, delta: "a" });
  m = applyMessageChange(m, { type: "text_delta", contentIndex: 0, delta: "b" });
  assert.deepEqual(m.content[0], { type: "text", text: "ab" });
  m = applyMessageChange(m, { type: "thinking_delta", contentIndex: 1, delta: "t" });
  m = applyMessageChange(m, { type: "thinking_delta", contentIndex: 1, delta: "u" });
  assert.deepEqual(m.content[1], { type: "thinking", thinking: "tu" });
  // A delta for the other block type starts that type fresh.
  m = applyMessageChange(m, { type: "thinking_delta", contentIndex: 0, delta: "z" });
  assert.deepEqual(m.content[0], { type: "thinking", thinking: "z" });
  m = applyMessageChange(m, { type: "text_delta", contentIndex: 1, delta: "q" });
  assert.deepEqual(m.content[1], { type: "text", text: "q" });
});

test("applyMessageChange: tool call argument deltas build nested objects and arrays", () => {
  let m = applyMessageChange(message(), { type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "c", name: "edit", arguments: {} } });
  m = applyMessageChange(m, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "path"], delta: "a." });
  m = applyMessageChange(m, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "path"], delta: "ts" });
  m = applyMessageChange(m, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "edits", 0, "old"], delta: "x" });
  m = applyMessageChange(m, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "edits", 0, "old"], delta: "y" });
  m = applyMessageChange(m, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "edits", 1, "old"], delta: "z" });
  const block = m.content[0];
  assert.equal(block.type, "toolCall");
  assert.deepEqual(block.type === "toolCall" && block.arguments, {
    path: "a.ts",
    edits: [{ old: "xy" }, { old: "z" }],
  });
  assert.ok(block.type === "toolCall" && Array.isArray((block.arguments as { edits: unknown }).edits));
  // A delta before any start creates a bare tool call block.
  const fresh = applyMessageChange(message(), { type: "toolcall_delta", contentIndex: 0, path: ["name"], delta: "ba" });
  assert.deepEqual(fresh.content[0], { type: "toolCall", id: "", name: "ba", arguments: {} });
});

// ------------------------------------------------------------------ AgentModel

test("AgentModel: subscribe/unsubscribe, ignored frames and touch/clear", () => {
  const model = new AgentModel();
  let calls = 0;
  const off = model.subscribe(() => calls++);
  assert.equal(model.apply({ type: "hello", apiVersion: 1, serverTime: 0, scope: { kind: "agent" } }), false);
  assert.equal(model.apply({ type: "disconnected", reason: "x" }), false);
  assert.equal(calls, 0, "ignored frames do not notify");
  assert.equal(model.apply({ type: "snapshot", snapshot: snap({ entries: [userEntry(1, "x")] }), inbox: [] }), true);
  assert.equal(calls, 1);
  model.touch();
  assert.equal(calls, 2);
  assert.equal(model.state.items.length, 1);
  model.clear();
  assert.equal(calls, 3);
  assert.deepEqual([model.state.ready, model.state.items, model.state.entries], [false, [], []]);
  off();
  model.touch();
  assert.equal(calls, 3, "an unsubscribed listener is no longer called");
});

test("AgentModel: a snapshot carries the live generation, retry, tools, compactions and run flag", () => {
  const model = new AgentModel();
  model.apply({
    type: "snapshot",
    inbox: [{ id: 1, mode: "followUp", content: "later" }],
    snapshot: snap({
      run: { inputs: [1] },
      generation: { attempt: 2, message: message([{ type: "text", text: "partial" }]), retry: { at: 99, error: "529" } },
      tools: [{ callId: "t", name: "bash", status: "running", output: "so far" } as never],
      compactions: [{ taskId: 4, reason: "auto", blocking: false, attempt: 1 }],
      agent: { model: { provider: "p", modelId: "m" }, cwd: "/w" },
    }),
  });
  const s = model.state;
  assert.equal(s.ready, true);
  assert.equal(s.running, true);
  assert.equal(s.generating, true);
  assert.deepEqual(s.retry, { at: 99, error: "529" });
  assert.deepEqual(s.compactions, [4]);
  assert.equal(s.agent.cwd, "/w");
  assert.deepEqual(s.inbox, [{ id: 1, mode: "followUp", content: "later" }]);
  assert.deepEqual(s.items.map((i) => [i.kind, i.kind === "assistant" && i.streaming]), [["assistant", true], ["tool", false]]);
  // A later snapshot with no run or generation clears the live parts.
  model.apply({ type: "snapshot", snapshot: snap(), inbox: [] });
  assert.deepEqual([model.state.running, model.state.generating, model.state.retry, model.state.compactions, model.state.items], [false, false, undefined, [], []]);
});

test("AgentModel: message_update without a message_start creates the live message; message_start of a user is ignored", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snap(), inbox: [] });
  model.apply(batch({ type: "message_start", message: { role: "user", content: "hi" } }));
  assert.equal(model.state.generating, false);
  model.apply(batch({ type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: "hey" }] }));
  assert.equal(model.state.generating, true);
  const live = model.state.items.at(-1);
  assert.ok(live?.kind === "assistant" && live.streaming && live.id === "live");
  assert.deepEqual(live.kind === "assistant" && live.blocks, [{ type: "text", text: "hey" }]);
  model.apply(batch({ type: "run_end", inputs: [] }));
  assert.equal(model.state.generating, false, "run_end drops the live message");
});

test("AgentModel: tool output set/append/trim, and an update for an unknown tool registers it", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snap(), inbox: [] });
  model.apply(batch({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", output: { append: "one\n" } }));
  const tool = () => model.state.items.find((i) => i.kind === "tool");
  assert.equal(tool()?.kind, "tool");
  const output = () => {
    const item = tool();
    return item?.kind === "tool" ? item.call.output : undefined;
  };
  assert.equal(output(), "one\n");
  model.apply(batch({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", output: { append: "two\n" } }));
  assert.equal(output(), "one\ntwo\n");
  model.apply(batch({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", output: { set: "replaced" } }));
  assert.equal(output(), "replaced");
  model.apply(batch({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", output: { trimStart: 3, append: "!" } }));
  assert.equal(output(), "laced!");
  model.apply(batch({ type: "tool_execution_update", toolCallId: "t", toolName: "bash" }));
  assert.equal(output(), "laced!", "an update without output keeps what is there");
  // End with no result entry just removes the live slot.
  model.apply(batch({ type: "tool_execution_end", toolCallId: "t", toolName: "bash" }));
  assert.equal(tool(), undefined);
});

test("AgentModel: agent, usage, retry, notices and compactions follow their events", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snap(), inbox: [] });
  model.apply(
    batch(
      { type: "agent_changed", agent: { cwd: "/new", thinkingLevel: "high" } },
      { type: "usage_changed", usage: { models: { "p/m": usage }, tools: {} } },
      { type: "auto_retry_start", attempt: 1, at: 123, errorMessage: "overloaded" },
    ),
  );
  assert.deepEqual(model.state.agent, { cwd: "/new", thinkingLevel: "high" });
  assert.deepEqual(Object.keys(model.state.usage.models), ["p/m"]);
  assert.deepEqual(model.state.retry, { at: 123, error: "overloaded" });
  model.apply(batch({ type: "auto_retry_end", attempt: 1 }));
  assert.equal(model.state.retry, undefined);

  model.apply(
    batch(
      { type: "compaction_start", taskId: 7, reason: "auto", blocking: false },
      { type: "compaction_start", taskId: 7, reason: "auto", blocking: false },
      { type: "compaction_start", taskId: 8, reason: "auto", blocking: true },
    ),
  );
  assert.deepEqual(model.state.compactions, [7, 8], "a repeated start is not listed twice");
  model.apply(batch({ type: "compaction_end", taskId: 7, reason: "auto" }));
  assert.deepEqual(model.state.compactions, [8]);

  for (let i = 1; i <= 12; i++) model.apply(batch({ type: "task_failed", taskId: i, kind: "pi.tool", message: `err ${i}` }));
  assert.equal(model.state.notices.length, 10, "only the ten newest notices are kept");
  assert.equal(model.state.notices[0], "pi.tool failed: err 3");
  assert.equal(model.state.notices.at(-1), "pi.tool failed: err 12");
});

test("AgentModel: events the reducer does not track leave the transcript alone", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snap({ entries: [userEntry(1, "x")] }), inbox: [] });
  const before = JSON.stringify(model.state.items);
  model.apply(
    batch(
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "inbox_update", items: [] },
      { type: "submission", record: { id: 1, status: "done" } },
      { type: "deferred_poll", pollAt: 5 },
    ),
  );
  assert.equal(JSON.stringify(model.state.items), before);
});

test("AgentModel: a compaction entry becomes the new head; entries stay ordered by id", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snap({ entries: [userEntry(3, "c"), userEntry(1, "a"), userEntry(2, "b")] }), inbox: [] });
  assert.deepEqual(model.state.entries.map((e) => e.id), [1, 2, 3]);
  model.apply(batch({ type: "entry_appended", entry: { id: 6, conversationId: 1, kind: "pi.compaction", head: 3, model: [{ role: "user", content: "summary" }] } }));
  assert.deepEqual(model.state.entries.map((e) => e.id), [3, 6]);
  const last = model.state.items.at(-1);
  assert.ok(last?.kind === "event" && last.text === "Context compacted. Earlier entries remain stored." && last.note === "summary");
  // Without a head, the entry's own id is the cut.
  model.apply(batch({ type: "entry_appended", entry: { id: 9, conversationId: 1, kind: "pi.reset" } }));
  assert.deepEqual(model.state.entries.map((e) => e.id), [9]);
});

test("AgentModel: doc frames replace one document and keep the others", () => {
  const model = new AgentModel();
  model.apply({ type: "doc", kind: "a", value: 1 });
  model.apply({ type: "doc", kind: "b", value: 2 });
  model.apply({ type: "doc", kind: "a", value: 3 });
  assert.deepEqual(model.state.docs, { a: 3, b: 2 });
});

// ------------------------------------------------------------------ SessionModel

const task = (id: number, conversationId: number, background: boolean): TaskNode => ({
  id,
  kind: "pi.generation",
  conversationId,
  background,
  state: { status: "running" },
  conversations: [],
});

test("SessionModel: partial frames update one slice; unknown frames are ignored; clear resets", () => {
  const model = new SessionModel();
  let notified = 0;
  model.subscribe(() => notified++);
  assert.equal(model.state.ready, false);
  assert.equal(model.apply({ type: "hello", apiVersion: 1, serverTime: 0, scope: { kind: "session" } }), false);
  assert.equal(notified, 0);
  model.apply({ type: "agents", agents: [agentSummary(1)] });
  model.apply({ type: "tasks", tasks: [task(1, 1, false), task(2, 1, true), task(3, 2, true)] });
  model.apply({ type: "usage", usage: { models: { m: usage }, tools: {} } });
  assert.equal(notified, 3);
  assert.deepEqual(model.state.agents.map((a) => a.id), [1]);
  assert.equal(model.state.ready, false, "only a full session frame marks it ready");
  model.apply({ type: "session", agents: [agentSummary(1), agentSummary(2)], tasks: model.state.tasks, usage: model.state.usage });
  assert.equal(model.state.ready, true);
  assert.equal(model.agent(2)?.name, "A2");
  assert.equal(model.agent(99), undefined);
  assert.equal(agentLabel({ id: 1, name: "Main" }), "Main");
  assert.equal(model.foregroundBusy(1), true);
  assert.equal(model.foregroundBusy(2), false, "background tasks do not make an agent foreground-busy");
  assert.deepEqual(model.backgroundTasks().map((t) => t.id), [2, 3]);
  assert.deepEqual(model.backgroundTasks(1).map((t) => t.id), [2]);
  assert.deepEqual(model.backgroundTasks(5), []);
  model.clear();
  assert.deepEqual(model.state, { agents: [], tasks: [], usage: { models: {}, tools: {} }, ready: false });
  assert.equal(notified, 5);
});

test("SessionModel.lineage follows fork parents", () => {
  const model = new SessionModel();
  model.apply({ type: "agents", agents: [agentSummary(1), agentSummary(2, { kind: "fork", parentId: 1 }), agentSummary(3, { kind: "fork", parentId: 2 })] });
  assert.deepEqual(model.lineage(3).map((a) => a.id), [1, 2, 3]);
});

// ------------------------------------------------------------------ lineage and tree

test("lineage stops at a missing parent, an unknown id and a parent cycle", () => {
  const agents = [agentSummary(1, { parentId: 9 }), agentSummary(2, { parentId: 1 })];
  assert.deepEqual(lineage(agents, 2).map((a) => a.id), [1, 2], "an unknown parent ends the chain");
  assert.deepEqual(lineage(agents, 42), []);
  const loop = [agentSummary(1, { parentId: 2 }), agentSummary(2, { parentId: 1 })];
  assert.deepEqual(lineage(loop, 1).map((a) => a.id), [2, 1], "a cycle is walked once");
  assert.deepEqual(lineage([], 1), []);
});

const session = (agents: AgentSummary[]): SessionSummary => ({ id: "s1", name: "S", cwd: "/w", model: "m", createdAt: 1, dbPath: "/d", busy: false, agents });

test("agentTree nests by fork parent or owner, and keeps orphans and self-references at the top", () => {
  const agents = [
    agentSummary(1),
    agentSummary(2, { kind: "fork", parentId: 1 }),
    agentSummary(3, { kind: "subagent", ownerAgentId: 2 }),
    agentSummary(4, { kind: "fork", parentId: 99 }),
    agentSummary(5, { parentId: 5 }),
  ];
  const roots = agentTree("dev", session(agents), true);
  assert.deepEqual(roots.map((n) => n.type === "agent" && n.agent.id), [1, 4, 5]);
  const one = roots[0];
  assert.equal(one.key, "dev/s/s1/a/1");
  assert.equal(one.stale, true);
  assert.deepEqual(one.children.map((n) => n.type === "agent" && n.agent.id), [2]);
  assert.deepEqual(one.children[0].children.map((n) => n.type === "agent" && n.agent.id), [3]);
  assert.equal(one.children[0].children[0].key, "dev/s/s1/a/3");
});

test("tree key helpers", () => {
  assert.equal(deviceKey("box"), "box");
  assert.equal(sessionKey("box", "s1"), "box/s/s1");
  assert.equal(agentKey("box", "s1", 4), "box/s/s1/a/4");
});

const device = (over: Partial<NetworkDevice> = {}): NetworkDevice => ({
  id: "box",
  name: "Box",
  kind: "ssh",
  url: "http://box:4780",
  source: "config",
  hasToken: true,
  status: "online",
  ...over,
});

test("networkTree: devices without a tree have no children; only online devices are fresh", () => {
  const [plain, offline, checking] = networkTree([device(), device({ id: "b", status: "offline" }), device({ id: "c", status: "checking" })]);
  assert.deepEqual([plain.stale, plain.children], [false, []]);
  assert.equal(offline.stale, true);
  assert.equal(checking.stale, true);
  assert.equal(plain.type === "device" && plain.status, "online");
  assert.deepEqual(networkTree([]), []);
  const [withTree] = networkTree([device({ tree: { uid: "u", name: "box", at: 1, sessions: [session([agentSummary(1)])] } })]);
  assert.equal(withTree.children[0].type, "session");
  assert.equal(withTree.children[0].children[0].stale, false, "staleness is inherited by every level");
});

// ------------------------------------------------------------------ NetworkModel

test("NetworkModel keeps the last device list and builds a tree from it", () => {
  const model = new NetworkModel();
  let notified = 0;
  model.subscribe(() => notified++);
  assert.equal(model.apply({ type: "usage", usage: { models: {}, tools: {} } }), false);
  assert.equal(notified, 0);
  assert.equal(model.apply({ type: "network", devices: [device(), device({ id: "other" })] }), true);
  assert.equal(notified, 1);
  assert.equal(model.device("other")?.id, "other");
  assert.equal(model.device("none"), undefined);
  assert.deepEqual(model.tree().map((n) => n.key), ["box", "other"]);
  model.apply({ type: "network", devices: [] });
  assert.deepEqual(model.devices, []);
});
