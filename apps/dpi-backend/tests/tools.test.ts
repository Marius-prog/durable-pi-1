// The playground tools the stock faux model has no command for (read_state, update_state, subagent, handoff) and
// the deeper paths of search_history and ping_on_call_engineer. A scripted faux model, installed over the store's
// own, makes the agent call exactly the tool a test names; the tools themselves run for real inside the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Store } from "../src/store.js";
import { SharedState } from "../src/shared-state.js";
import { createJobs } from "../src/jobs.js";
import { createPlayground } from "../src/extensions.js";
import { faux, tempStore } from "./helpers.js";

type Message = { role: string; content?: unknown };
const textOf = (m?: Message) =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? (m!.content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("") : "";

/** Replace the store's provider with one that answers by a table: a prompt maps to one tool call, anything else echoes. */
function script(store: Store, calls: Record<string, [name: string, args: Record<string, unknown>]>) {
  const handle = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Faux Echo", contextWindow: 128000, maxTokens: 8192 }], tokensPerSecond: 1000 });
  const reply: FauxResponseFactory = (context) => {
    handle.appendResponses([reply]);
    const messages = context.messages as unknown as Message[];
    if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage(fauxText(`Tool finished: ${textOf(messages.at(-1)).trim().slice(0, 300)}`));
    const prompt = textOf([...messages].reverse().find((m) => m.role === "user")).trim();
    const call = calls[prompt];
    if (call) return fauxAssistantMessage([fauxText(`Calling ${call[0]}.`), fauxToolCall(call[0], call[1] as never)], { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxText(`Echo: ${prompt}`));
  };
  handle.setResponses([reply]);
  store.models.setProvider(handle.provider);
}

async function withScripted(calls: Record<string, [string, Record<string, unknown>]>, body: (x: { store: Store; t: Awaited<ReturnType<typeof tempStore>>; turn: (prompt: string) => Promise<Turn>; session: string }) => Promise<void>) {
  const t = await tempStore();
  const store = await t.open();
  try {
    script(store, calls);
    const session = await store.create({ name: "Scripted", cwd: t.work, model: faux });
    let n = 0;
    const turn = async (prompt: string) => {
      const { h, c } = await store.resolveAgent(session.id, "main");
      const sent = await store.send(c, { content: prompt, requestId: `tool-${++n}` });
      const settled = await store.settled(h, sent.id as number, 60_000);
      assert.equal(settled.status, "done");
      const result = (await store.entries(c, undefined, 100)).items.find((e) => e.kind === "pi.tool-result");
      const message = (result?.model?.[0] ?? {}) as { toolName?: string; isError?: boolean; content?: { text?: string }[] };
      return { tool: message.toolName, error: message.isError === true, text: (message.content ?? []).map((x) => x.text ?? "").join(""), answer: settled.status === "done" ? settled.answer.text : "" } as Turn;
    };
    await body({ store, t, turn, session: session.id });
  } finally {
    await store.close();
    await t.cleanup();
  }
}
type Turn = { tool?: string; error: boolean; text: string; answer: string };
const shared = async (store: Store) => (await store.deviceDoc("app.shared-state")).value as Record<string, unknown>;

test("read_state returns the whole shared object, a field at a pointer, or a precise error", () =>
  withScripted(
    {
      "read all": ["read_state", {}],
      "read goal": ["read_state", { path: "/goal" }],
      "read missing": ["read_state", { path: "/nope" }],
      "read bad pointer": ["read_state", { path: "goal" }],
      "read element": ["read_state", { path: "/notes/0" }],
    },
    async ({ store, turn, session }) => {
      const { c } = await store.resolveAgent(session, "main");
      const all = await turn("read all");
      assert.equal(all.tool, "read_state");
      assert.deepEqual(JSON.parse(all.text), await shared(store));
      assert.equal((await turn("read goal")).text, JSON.stringify("Explore durable agents"));
      const missing = await turn("read missing");
      assert.equal(missing.error, true);
      assert.match(missing.text, /Field does not exist: nope/);
      const bad = await turn("read bad pointer");
      assert.equal(bad.error, true);
      assert.match(bad.text, /Use a JSON Pointer path/);
      await store.demoState(c, { note: "first note" });
      assert.equal((await turn("read element")).text, JSON.stringify("first note"));
    },
  ));

test("update_state creates, updates, increments and deletes, and each change leaves a transcript entry", () =>
  withScripted(
    {
      create: ["update_state", { operation: "create", path: "/made", value_json: '{"a":1,"b":[true,null]}' }],
      update: ["update_state", { operation: "update", path: "/made/a", value_json: "2" }],
      increment: ["update_state", { operation: "increment", path: "/made/a", value_json: "5" }],
      append: ["update_state", { operation: "create", path: "/notes/-", value_json: '"from the agent"' }],
      delete: ["update_state", { operation: "delete", path: "/made" }],
      "bad json": ["update_state", { operation: "create", path: "/x", value_json: "{not json" }],
      "no value": ["update_state", { operation: "create", path: "/x" }],
      "wrong type": ["update_state", { operation: "increment", path: "/goal", value_json: "1" }],
      "missing parent": ["update_state", { operation: "create", path: "/a/b/c", value_json: "1" }],
      "double create": ["update_state", { operation: "create", path: "/goal", value_json: '"again"' }],
    },
    async ({ store, turn, session }) => {
      const { c } = await store.resolveAgent(session, "main");
      const before = await shared(store);
      const created = await turn("create");
      assert.equal(created.tool, "update_state");
      assert.deepEqual(JSON.parse(created.text).made, { a: 1, b: [true, null] });
      assert.deepEqual((await shared(store)).made, { a: 1, b: [true, null] });
      await turn("update");
      assert.equal(((await shared(store)).made as { a: number }).a, 2);
      assert.equal(JSON.parse((await turn("increment")).text).made.a, 7);
      await turn("append");
      assert.equal(((await shared(store)).notes as string[]).at(-1), "from the agent");
      await turn("delete");
      assert.equal((await shared(store)).made, undefined);

      const revision = (await store.deviceDoc("app.shared-state")).revision;
      const entries = (await store.entries(c, undefined, 200)).items.filter((e) => e.kind === "demo.state-change");
      assert.deepEqual(entries.map((e) => (e.data as { text: string }).text).reverse(), [
        "App State: create /made",
        "App State: update /made/a",
        "App State: increment /made/a",
        "App State: create /notes/-",
        "App State: delete /made",
      ]);

      // Refused changes are tool errors, change nothing and leave no entry.
      for (const [prompt, message] of [
        ["bad json", /JSON|Unexpected token|Expected/],
        ["no value", /Value must be valid JSON/],
        ["wrong type", /Increment requires numbers/],
        ["missing parent", /Field does not exist: a/],
        ["double create", /Field already exists/],
      ] as const) {
        const r = await turn(prompt);
        assert.equal(r.error, true, prompt);
        assert.match(r.text, message, prompt);
      }
      assert.equal((await store.deviceDoc("app.shared-state")).revision, revision, "no refused change bumped the revision");
      assert.equal((await store.entries(c, undefined, 200)).items.filter((e) => e.kind === "demo.state-change").length, entries.length);
      assert.equal((await shared(store)).goal, before.goal);
    },
  ));

test("update_state applies once per tool call: the same call replayed finds its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-tools-"));
  const state = await SharedState.open(join(root, "state.sqlite"));
  try {
    await state.initialize({ counter: 0 });
    const playground = createPlayground(state, "sess-1", (async () => ({})) as never, createJobs({ shared: state, sessionId: "sess-1" }));
    const tool = playground.tools!.find((x) => x.name === "update_state")!;
    // Stand-ins for the harness: a document store keyed like the real task-scoped receipt, and an entry list.
    const receipts = new Map<string, { applied: boolean; result: string }>();
    const appended: unknown[] = [];
    const api = (taskId: number) => ({
      taskId,
      conversationId: 1,
      commit: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          doc: async (_token: unknown, id: number) => {
            if (!receipts.has(String(id))) receipts.set(String(id), { applied: false, result: "" });
            return receipts.get(String(id));
          },
          appendEntry: async (_c: unknown, entry: unknown) => void appended.push(entry),
        }),
    });
    const run = (taskId: number) =>
      (tool.execute as (a: unknown, api: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>)({ operation: "increment", path: "/counter", value_json: "1" }, api(taskId), ctx);

    const first = await run(41);
    const replay = await run(41);
    assert.deepEqual(replay, first, "a replay returns the stored result");
    assert.equal(((await state.snapshot()).value as { counter: number }).counter, 1, "applied once");
    assert.equal(appended.length, 1, "one transcript entry");
    await run(42);
    assert.equal(((await state.snapshot()).value as { counter: number }).counter, 2, "a different call is a different change");
    assert.equal(appended.length, 2);
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff starts a fresh context with the note and keeps the old transcript stored", () =>
  withScripted({ "hand over": ["handoff", { note: "Remember: the answer is 42." }] }, async ({ store, turn, session }) => {
    const { c } = await store.resolveAgent(session, "main");
    await turn("first question");
    const done = await turn("hand over");
    assert.equal(done.tool, "handoff");
    assert.equal(done.text, "Context handed off.");
    const all = (await store.entries(c, undefined, 200)).items;
    assert.ok(all.some((e) => JSON.stringify(e.model).includes("first question")), "the old transcript is still stored");
    assert.ok(all.some((e) => JSON.stringify(e).includes("Remember: the answer is 42.")), "the note is in the history");
    assert.ok(JSON.stringify(await store.activeEntries(c)).includes("Remember: the answer is 42."));
  }));

test("subagent runs the task in an owned child that cannot delegate further, and reports its answer", () =>
  withScripted({ delegate: ["subagent", { task: "child job: count to three" }] }, async ({ store, turn, session }) => {
    const done = await turn("delegate");
    assert.equal(done.tool, "subagent");
    assert.equal(done.error, false);
    assert.match(done.text, /Echo: child job: count to three/);
    const { row } = await store.resolveAgent(session, "main");
    const agents = await store.agents(row);
    const child = agents.find((a) => a.kind === "subagent");
    assert.ok(child, "the child is listed under the session");
    assert.equal(child!.ownerAgentId, 1);
    const detail = await store.agentDetail(row, (await store.resolveAgent(session, String(child!.id))).c);
    const offered = (name: string) => detail.tools.find((x) => x.name === name)?.offered;
    assert.equal(offered("subagent"), false, "the child is not offered subagent");
    assert.equal(offered("bash"), true, "but keeps the others");
    assert.equal((await store.agentDetail(row, (await store.resolveAgent(session, "main")).c)).tools.find((x) => x.name === "subagent")?.offered, true, "the parent still is");
    // The child's own transcript has the task and the answer.
    const md = (await store.transcript((await store.resolveAgent(session, String(child!.id))).c, "markdown")) as { text: string };
    assert.match(md.text, /child job: count to three/);
    assert.match(md.text, /Echo: child job: count to three/);
  }));

test("search_history reads past the first 500 entries and pages through them", () =>
  withScripted(
    {
      "search many": ["search_history", { query: "increment", limit: 3 }],
      "search tail": ["search_history", { query: "increment", limit: 50, offset: 515, order: "oldest" }],
      "read entry": ["search_history", { entry: 1 }],
    },
    async ({ store, turn, session }) => {
      const { c } = await store.resolveAgent(session, "main");
      for (let i = 0; i < 520; i++) await store.demoState(c, { increment: true });
      const many = JSON.parse((await turn("search many")).text) as { total: number; results: { entry: number; text: string }[]; next_offset: number | null };
      // 520 state changes. The search's own call and result never match unless asked for by name.
      assert.equal(many.total, 520);
      assert.equal(many.results.length, 3);
      assert.equal(many.next_offset, 3);
      assert.ok(many.results.every((r) => /increment/.test(r.text)));
      const newest = many.results[0].entry;
      assert.ok(many.results[0].entry > many.results[2].entry, "newest first");
      const tail = JSON.parse((await turn("search tail")).text) as { total: number; results: { entry: number }[]; next_offset: number | null };
      assert.equal(tail.total, 521, "the agent's reply that quotes the first search is now in the history too");
      assert.equal(tail.results.length, 6, "everything after the 515th oldest, which is past the first 500 entries read");
      assert.equal(tail.next_offset, null, "nothing after them");
      assert.ok(tail.results.at(-1)!.entry > newest, "oldest first, so the last one is the newest entry");
    },
  ));

test("ping_on_call_engineer pages with the given severity and refuses a second page", () =>
  withScripted(
    {
      "page critical": ["ping_on_call_engineer", { summary: "disk is full", severity: "critical" }],
      "page again": ["ping_on_call_engineer", { summary: "still full" }],
    },
    async ({ turn }) => {
      const first = await turn("page critical");
      assert.equal(first.tool, "ping_on_call_engineer");
      assert.equal(first.error, false);
      assert.match(first.text, /^Paged the on-call engineer \(PG-\d{4}, critical\)\. They acknowledged\. Do not page again for this\.$/);
      const second = await turn("page again");
      assert.equal(second.error, true);
      assert.match(second.text, /Already paged at \d{4}-\d\d-\d\dT.*\(PG-\d{4}\)\. ping_on_call_engineer works once per agent\./);
    },
  ));
