import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSummary, Frame, WireEntry, WireSnapshotEvent, WireUsage } from "../../dpi-sdk/src/api.ts";
import { pickAgent } from "../src/pickers.ts";
import { spinner } from "../src/render.ts";
import { agent, session, settle, until } from "./support/fake-device.ts";
import { strip } from "./support/fake-terminal.ts";
import { batch, withApp, type Launched } from "./support/launch.ts";

const SID = "11111111-aaaa-4aaa-8aaa-111111111111";
const ENTER = "\r";
const ESC = "\x1b";
const ALT_ENTER = "\x1b\r";
const SHIFT_TAB = "\x1b[Z";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_L = "\x0c";
const CTRL_O = "\x0f";
const UP = "\x1b[A";

const usage = (totalTokens: number, cost = 0, extra: Partial<WireUsage> = {}): WireUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  ...extra,
});
const userEntry = (id: number, text: string): WireEntry => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text }] });
const assistantEntry = (id: number, text: string, u?: WireUsage): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [{ role: "assistant", content: [{ type: "text", text }], provider: "faux", model: "beta-2", usage: u as WireUsage, stopReason: "stop" }],
});
const snapshotOf = (extra: Partial<WireSnapshotEvent> = {}): Frame => ({
  type: "snapshot",
  snapshot: {
    type: "snapshot",
    entries: [],
    tools: [],
    compactions: [],
    inbox: [],
    agent: { model: { provider: "faux", modelId: "beta-2" }, thinkingLevel: "low" },
    usage: { models: {}, tools: {} },
    ...extra,
  },
  inbox: [],
});
/** Push a frame to the agent stream and wait for the footer to settle. */
const push = async (ctx: Launched, frame: Frame) => {
  ctx.device.pushAgent(frame);
  await settle(30);
};
const pushSession = async (ctx: Launched, frame: Frame) => {
  ctx.device.pushSession(frame);
  await settle(30);
};
const sent = (ctx: Launched) => ctx.device.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"));
const calls = (ctx: Launched, method: string, suffix: string) => ctx.device.requests.filter((r) => r.method === method && r.path.endsWith(suffix));
const priv = (ctx: Launched) => ctx.app as unknown as Record<string, any>;
const overlays = (ctx: Launched) => priv(ctx).overlays.length as number;
const reattachHint = (ctx: Launched) => strip(ctx.stdout.join("")).trim();

// ------------------------------------------------------------------ construction and open

test("a new App draws an empty header and footer, and paints them to the terminal", async () => {
  await withApp({}, async (ctx) => {
    assert.equal(ctx.header(), "dpi  │  device fake  │  no workspace  │  ○ no agent");
    assert.equal(ctx.footer(), "0 tok $0.000 │ /help");
    await settle();
    assert.match(ctx.term.screen(), /device fake/);
    assert.match(ctx.term.screen(), /○ no agent/);
    assert.deepEqual(ctx.status(), []);
  });
});

test("open attaches to a session's root agent and both streams go live", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.header().includes("agent Main"), "the session stream to name the agent");
    assert.equal(ctx.header(), "dpi  │  device fake  │  workspace triage  │  agent Main  │  ● live");
    assert.equal(ctx.app.sessionId, SID);
    assert.equal(ctx.app.agentId, 1);
    await until(() => ctx.device.openSessionStreams === 1, "the session stream");
    assert.equal(ctx.device.openAgentStreams, 1);
    assert.equal(ctx.device.seen("GET /v1/sessions/triage").length > 0, true);
  });
});

test("open with an agent reference resolves it (by name or 'main') and shows the lineage", async () => {
  await withApp({ open: ["triage", "alt-path"] }, async (ctx) => {
    assert.equal(ctx.app.agentId, 2);
    await until(() => ctx.header().includes("fork ⑂ alt-path"), "the lineage");
    assert.equal(ctx.header(), "dpi  │  device fake  │  workspace triage  │  agent Main › fork ⑂ alt-path  │  ● live");
  });
  await withApp({ open: ["triage", "main"] }, async (ctx) => assert.equal(ctx.app.agentId, 1));
});

test("a subagent is labelled as one", async () => {
  await withApp({ open: ["triage", "helper"] }, async (ctx) => {
    await until(() => ctx.header().includes("subagent ↳ helper"), "the subagent label");
    assert.equal(ctx.app.agentId, 3);
  });
});

test("open without a session opens the session picker", async () => {
  await withApp({}, async (ctx) => {
    await ctx.app.open();
    assert.equal(overlays(ctx), 1);
    await settle();
    assert.match(ctx.term.screen(), /Sessions on fake/);
    assert.match(ctx.term.screen(), /＋ New session/);
    assert.equal(ctx.app.sessionId, undefined);
  });
});

test("open with an unknown session or agent flashes the error and falls back to the picker", async () => {
  await withApp({}, async (ctx) => {
    await ctx.app.open("nope");
    assert.deepEqual(ctx.status(), ["No session nope"]);
    assert.equal(overlays(ctx), 1, "the picker is open");
    assert.equal(ctx.app.sessionId, undefined);
    ctx.term.type(CTRL_C); // close the picker
    assert.equal(overlays(ctx), 0);
    await ctx.app.open("triage", "ghost");
    assert.match(ctx.status().join("\n"), /No agent ghost/);
    assert.equal(overlays(ctx), 1);
    assert.equal(ctx.app.sessionId, undefined, "nothing was attached");
  });
});

test("choosing a session in the picker with the keyboard attaches to it", async () => {
  await withApp({}, async (ctx) => {
    await ctx.app.open();
    ctx.type("\x1b[B"); // down: past "New session" to triage
    ctx.type(ENTER);
    await until(() => ctx.header().includes("● live"), "the agent stream");
    assert.equal(ctx.app.sessionId, SID);
    assert.equal(overlays(ctx), 0);
  });
});

test("attaching to another agent keeps the session stream; another session replaces both streams", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.device.openSessionStreams === 1, "session stream");
    await ctx.app.attach(SID, 2);
    await until(() => ctx.header().includes("alt-path"), "the new agent");
    await until(() => ctx.device.openAgentStreams === 1 && ctx.device.openSessionStreams === 1, "one stream each after switching agents");

    const other = ctx.device.sessions[1];
    await ctx.app.attach(other.id, 1);
    await until(() => ctx.header().includes("workspace review"), "the other session");
    await until(() => ctx.device.openAgentStreams === 1 && ctx.device.openSessionStreams === 1, "old streams closed");
    assert.equal(ctx.app.sessionId, other.id);
  });
});

// ------------------------------------------------------------------ connection state

test("the header shows connecting, then live", async () => {
  await withApp({}, async (ctx) => {
    void ctx.app.attach(SID, 1);
    assert.match(ctx.header(), /◌ connecting$/);
    await until(() => ctx.header().endsWith("● live"), "live");
  });
});

test("a rejected token or a vanished agent ends the stream with that state and says why", async () => {
  await withApp({}, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/agents/1/events"), status: 401, code: "unauthorized", message: "token rejected" });
    await ctx.app.attach(SID, 1);
    await until(() => ctx.header().endsWith("○ unauthorized"), "unauthorized");
    assert.ok(ctx.status().includes("token rejected"));
  });
  await withApp({}, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/agents/1/events"), status: 404, code: "not_found", message: "agent is gone" });
    await ctx.app.attach(SID, 1);
    await until(() => ctx.header().endsWith("○ gone"), "gone");
    assert.ok(ctx.status().includes("agent is gone"));
  });
});

test("a dropped connection shows offline without a notice and recovers by itself", { timeout: 15_000 }, async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/agents/1/events"), destroy: true });
    await ctx.app.attach(SID, 1); // reopen the agent stream; the first attempt is dropped
    await until(() => ctx.header().endsWith("○ offline"), "offline");
    assert.deepEqual(ctx.status(), [], "going offline is not an error flash");
    await until(() => ctx.header().endsWith("● live"), "the reconnect", 8000);
  });
});

// ------------------------------------------------------------------ footer

test("the footer shows model, thinking level, context left, tokens, cost and background tasks", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(
      ctx,
      snapshotOf({
        entries: [userEntry(1, "hi"), assistantEntry(2, "hello", usage(50_000, 0.0123)), userEntry(3, "more")],
        usage: { models: { "faux/beta-2": usage(52_000, 0.0123), "faux/other": usage(1_500, 0.001) }, tools: {} },
      }),
    );
    assert.equal(ctx.footer(), "beta-2: low │ 75% CTX │ 53.5K tok $0.013 │ /help");
    await pushSession(ctx, { type: "tasks", tasks: [{ id: 1, kind: "job", conversationId: 1, background: true, state: { status: "running" }, conversations: [] }, { id: 2, kind: "job", conversationId: 2, background: true, state: { status: "running" }, conversations: [] }] });
    assert.equal(ctx.footer(), "beta-2: low │ 75% CTX │ 53.5K tok $0.013 │ 1 bg │ /help", "only this agent's background tasks count");
  });
});

test("context left uses the sum of the parts when the total is missing, and never goes below zero", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ entries: [assistantEntry(2, "x", usage(0, 0, { input: 1000, output: 500 }))] }));
    assert.match(ctx.footer(), /99% CTX/);
    await push(
      ctx,
      snapshotOf({ agent: { model: { provider: "faux", modelId: "alpha-1" }, thinkingLevel: "high" }, entries: [assistantEntry(2, "x", usage(5_000))] }),
    );
    assert.match(ctx.footer(), /^alpha-1: high │ 0% CTX/);
  });
});

test("context left looks past replies without usage, and is omitted for a model the device does not list", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ entries: [assistantEntry(2, "x", usage(100_000)), assistantEntry(4, "y")] }));
    assert.match(ctx.footer(), /50% CTX/, "the newest reply has no usage, so the one before it counts");
    await push(ctx, snapshotOf({ entries: [assistantEntry(2, "x")] }));
    assert.match(ctx.footer(), /100% CTX/, "no usage anywhere: nothing used yet");
    await push(ctx, snapshotOf({ agent: { model: { provider: "faux", modelId: "unknown-model" } }, entries: [assistantEntry(2, "x", usage(10))] }));
    assert.ok(!ctx.footer().includes("CTX"), "model not in the device's list");
  });
});

test("the footer shows the last path segment of the model id, defaults the level to low, and omits an unset model", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ agent: { model: { provider: "openrouter", modelId: "vendor/fancy-1" } } }));
    assert.equal(ctx.footer(), "fancy-1: low │ 0 tok $0.000 │ /help");
    await push(ctx, snapshotOf({ agent: {} }));
    assert.equal(ctx.footer(), "0 tok $0.000 │ /help");
  });
});

// ------------------------------------------------------------------ status lines

test("a running agent shows 'working…', 'retrying' or 'compacting…'", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ run: { inputs: [1] } }));
    assert.deepEqual(ctx.status(), ["● working… esc to interrupt"]);
    assert.equal(ctx.app.busy(), true);
    await push(ctx, snapshotOf({ run: { inputs: [1] }, compactions: [{ taskId: 4, reason: "threshold", blocking: false, attempt: 1 }] }));
    assert.deepEqual(ctx.status(), ["● compacting… esc to interrupt"]);
    await push(ctx, snapshotOf({ run: { inputs: [1] }, generation: { attempt: 1, retry: { at: 1, error: "429 rate limited" } } }));
    assert.deepEqual(ctx.status(), ["● retrying: 429 rate limited esc to interrupt"]);
    await push(ctx, snapshotOf());
    assert.deepEqual(ctx.status(), []);
    assert.equal(ctx.app.busy(), false);
  });
});

test("a foreground task on this agent makes it busy; a background task or another agent's does not", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    const task = (id: number, conversationId: number, background: boolean) => ({ id, kind: "pi.tool", conversationId, background, state: { status: "running" }, conversations: [] });
    await pushSession(ctx, { type: "tasks", tasks: [task(1, 1, true), task(2, 2, false)] });
    assert.equal(ctx.app.busy(), false);
    await pushSession(ctx, { type: "tasks", tasks: [task(3, 1, false)] });
    assert.equal(ctx.app.busy(), true);
    assert.deepEqual(ctx.status(), ["● working… esc to interrupt"]);
  });
});

test("queued messages, steering and notices are listed under the transcript", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, { type: "inbox", items: [{ id: 1, mode: "steer", content: "focus  on\ntests" }, { id: 2, mode: "followUp", content: "then ship" }, { id: 3, mode: "write" }] });
    assert.deepEqual(ctx.status(), ["↪ steer: focus on tests", "⏳ queued: then ship", "⏳ queued: context update"]);
    await push(ctx, batch(
      { type: "task_failed", taskId: 1, kind: "a", message: "one" },
      { type: "task_failed", taskId: 2, kind: "b", message: "two" },
      { type: "task_failed", taskId: 3, kind: "c", message: "three" },
    ));
    assert.deepEqual(ctx.status().slice(-2), ["b failed: two", "c failed: three"], "the last two notices");
  });
});

test("a flash is green, an error flash is red, and each disappears after six seconds", async () => {
  await withApp({}, async (ctx) => {
    ctx.app.flash("saved");
    assert.deepEqual(ctx.status(), ["saved"]);
    assert.ok(priv(ctx).statusLines()[0].includes("38;2;111;207;151"));
    ctx.app.flash("broken", true);
    assert.deepEqual(ctx.status(), ["broken"], "a new flash replaces the old one");
    assert.ok(priv(ctx).statusLines()[0].includes("38;2;255;107;107"));
    priv(ctx).notice.at -= 5_900;
    assert.deepEqual(ctx.status(), ["broken"]);
    priv(ctx).notice.at -= 200;
    assert.deepEqual(ctx.status(), []);
  });
});

test("run flashes the message of a failing action and returns normally", async () => {
  await withApp({}, async (ctx) => {
    await ctx.app.run(async () => {});
    assert.deepEqual(ctx.status(), []);
    await ctx.app.run(async () => {
      throw new Error("kaput");
    });
    assert.deepEqual(ctx.status(), ["kaput"]);
  });
});

// ------------------------------------------------------------------ the spinner

test("a running tool starts the spinner ticker and finishing it stops it", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    assert.equal(priv(ctx).ticker, undefined);
    await push(ctx, snapshotOf({ tools: [{ callId: "c1", name: "bash", status: "running", output: "x" }] }));
    assert.ok(priv(ctx).ticker, "ticker running");
    await push(ctx, snapshotOf());
    assert.equal(priv(ctx).ticker, undefined, "ticker cleared");
  });
});

test("the ticker advances the spinner while a tool runs, including one inside the live assistant message", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    const before = spinner.frame;
    await push(
      ctx,
      batch(
        { type: "run_start", inputs: [1] },
        { type: "message_start", message: { role: "assistant", content: [], provider: "faux", model: "beta-2", usage: usage(0), stopReason: "pending" } },
        { type: "message_update", usage: usage(0), changes: [{ type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "c9", name: "bash", arguments: { command: "sleep 1" } } }] },
        { type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: { command: "sleep 1" } },
      ),
    );
    assert.ok(priv(ctx).ticker, "ticker running for a tool inside the assistant message");
    await until(() => spinner.frame >= before + 2, "the spinner to advance", 2000);
    await push(ctx, batch({ type: "tool_execution_end", toolCallId: "c9", toolName: "bash" }, { type: "run_end", inputs: [1] }));
    assert.equal(priv(ctx).ticker, undefined);
  });
});

test("exit stops the spinner ticker too", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ tools: [{ callId: "c1", name: "bash", status: "running" }] }));
    assert.ok(priv(ctx).ticker);
    ctx.exit();
    await until(() => ctx.device.openAgentStreams === 0, "streams closed");
  });
});

// ------------------------------------------------------------------ sending

test("Enter sends the typed text as a follow-up with a request id, and Up recalls it", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.typeText("hello there");
    ctx.type(ENTER);
    await until(() => sent(ctx).length === 1, "the message");
    const [request] = sent(ctx);
    assert.match(request.path, new RegExp(`/v1/sessions/${SID}/agents/1/messages$`));
    assert.equal(request.body.content, "hello there");
    assert.equal(request.body.whenBusy, "followUp");
    assert.match(request.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(priv(ctx).editor.getText(), "");
    await settle();
    ctx.type(UP);
    assert.equal(priv(ctx).editor.getText(), "hello there", "history has the sent text");
  });
});

test("while the agent works Enter steers and says so", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ run: { inputs: [1] } }));
    ctx.typeText("change course");
    ctx.type(ENTER);
    await until(() => sent(ctx).length === 1, "the message");
    assert.equal(sent(ctx)[0].body.whenBusy, "steer");
    await until(() => ctx.status().includes("Steering: joins after the current tool round"), "the steering note");
  });
});

test("Alt+Enter queues a follow-up even while the agent works, and ignores an empty editor", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ run: { inputs: [1] } }));
    ctx.type(ALT_ENTER);
    await settle();
    assert.equal(sent(ctx).length, 0, "nothing to send");
    ctx.typeText("later");
    ctx.type(ALT_ENTER);
    await until(() => sent(ctx).length === 1, "the message");
    assert.equal(sent(ctx)[0].body.whenBusy, "followUp");
    assert.equal(sent(ctx)[0].body.content, "later");
    assert.equal(priv(ctx).editor.getText(), "");
  });
});

test("blank input is not sent, and text is trimmed", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.typeText("   ");
    ctx.type(ENTER);
    await settle();
    assert.equal(sent(ctx).length, 0);
    ctx.typeText("  padded  ");
    ctx.type(ENTER);
    await until(() => sent(ctx).length === 1, "the message");
    assert.equal(sent(ctx)[0].body.content, "padded");
  });
});

test("sending without a session says so", async () => {
  await withApp({}, async (ctx) => {
    ctx.typeText("hi");
    ctx.type(ENTER);
    await until(() => ctx.status().length > 0, "a notice");
    assert.deepEqual(ctx.status(), ["Pick a session first (/sessions)."]);
  });
});

test("a send that fails keeps the text in the editor and shows the error", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/messages"), status: 500, code: "internal", message: "model exploded" });
    ctx.typeText("will fail");
    ctx.type(ENTER);
    await until(() => ctx.status().includes("model exploded"), "the error");
    assert.equal(priv(ctx).editor.getText(), "will fail");
    assert.equal(sent(ctx).length, 1, "no retry for a server error");
  });
});

test("a busy rejection gets its own message", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/messages"), status: 409, code: "busy", message: "x" });
    ctx.typeText("hello");
    ctx.type(ENTER);
    await until(() => ctx.status().length > 0, "the error");
    assert.deepEqual(ctx.status(), ["Agent is busy (reject mode)"]);
  });
});

test("a send that cannot reach the device is retried with the same request id", { timeout: 15_000 }, async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/messages"), destroy: true });
    ctx.typeText("retry me");
    ctx.type(ENTER);
    await until(() => sent(ctx).length === 2, "the retry", 5000);
    assert.equal(sent(ctx)[0].body.requestId, sent(ctx)[1].body.requestId);
    assert.equal(sent(ctx)[1].body.content, "retry me");
    await settle();
    assert.deepEqual(ctx.status(), [], "the retry succeeded quietly");
    assert.equal(priv(ctx).editor.getText(), "");
  });
});

test("after three failed attempts the send gives up and keeps the text", { timeout: 20_000 }, async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    for (let i = 0; i < 3; i++) ctx.device.injections.push({ match: (r) => r.path.endsWith("/messages"), destroy: true });
    ctx.typeText("never arrives");
    ctx.type(ENTER);
    await until(() => ctx.status().length > 0, "the final error", 10_000);
    assert.equal(sent(ctx).length, 3);
    assert.equal(new Set(sent(ctx).map((r) => r.body.requestId)).size, 1, "one request id for every attempt");
    assert.match(ctx.status()[0], /Cannot reach/);
    assert.equal(priv(ctx).editor.getText(), "never arrives");
  });
});

// ------------------------------------------------------------------ slash commands from the editor

test("a known slash command runs instead of being sent", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.term.rows = 60; // tall enough for the whole panel
    ctx.typeText("/help");
    await settle();
    ctx.type(ENTER);
    await until(() => overlays(ctx) === 1, "the help panel");
    assert.equal(sent(ctx).length, 0);
    await settle();
    assert.match(ctx.term.screen(), /Closing dpi-tui never stops the agent/);
    ctx.type(ESC);
    assert.equal(overlays(ctx), 0, "esc closes the panel");
  });
});

test("an unknown slash command is sent to the agent as text", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.typeText("/frobnicate now");
    await settle();
    ctx.type(ENTER);
    await until(() => sent(ctx).length === 1, "the message");
    assert.equal(sent(ctx)[0].body.content, "/frobnicate now");
  });
});

test("/quit typed in the editor exits and prints how to reattach", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.header().includes("agent Main"), "session summary");
    await settle();
    ctx.typeText("/quit");
    await settle();
    ctx.type(ENTER);
    await until(() => ctx.exits.length > 0, "exit");
    assert.deepEqual(ctx.exits, [0]);
    assert.match(reattachHint(ctx), /just tui attach fake:triage:main/);
  });
});

// ------------------------------------------------------------------ keys

test("Esc interrupts a busy agent in the foreground only, and does nothing when idle", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.type(ESC);
    await settle();
    assert.equal(calls(ctx, "POST", "/abort").length, 0);
    await push(ctx, snapshotOf({ run: { inputs: [1] } }));
    ctx.type(ESC);
    await until(() => calls(ctx, "POST", "/abort").length === 1, "abort");
    assert.deepEqual(calls(ctx, "POST", "/abort")[0].body, { background: false });
    await until(() => ctx.status().includes("Interrupted. Background jobs continue."), "the note");
  });
});

test("Esc closes the command suggestions first and interrupts only on the next press", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await push(ctx, snapshotOf({ run: { inputs: [1] } }));
    ctx.typeText("/he");
    await settle();
    assert.equal(priv(ctx).editor.isShowingAutocomplete(), true);
    ctx.type(ESC);
    await settle();
    assert.equal(calls(ctx, "POST", "/abort").length, 0, "the first Esc went to the suggestions");
    assert.equal(priv(ctx).editor.isShowingAutocomplete(), false);
    ctx.type(ESC);
    await until(() => calls(ctx, "POST", "/abort").length === 1, "abort");
  });
});

test("Shift+Tab steps the thinking level and wraps from the highest to the lowest", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.type(SHIFT_TAB);
    await until(() => calls(ctx, "PATCH", "/config").length === 1, "config patch");
    assert.deepEqual(calls(ctx, "PATCH", "/config")[0].body, { thinkingLevel: "medium" });
    await push(ctx, snapshotOf({ agent: { model: { provider: "faux", modelId: "beta-2" }, thinkingLevel: "xhigh" } }));
    ctx.type(SHIFT_TAB);
    await until(() => calls(ctx, "PATCH", "/config").length === 2, "second patch");
    assert.deepEqual(calls(ctx, "PATCH", "/config")[1].body, { thinkingLevel: "off" });
    await push(ctx, snapshotOf({ agent: { model: { provider: "faux", modelId: "beta-2" } } }));
    ctx.type(SHIFT_TAB);
    await until(() => calls(ctx, "PATCH", "/config").length === 3, "third patch");
    assert.deepEqual(calls(ctx, "PATCH", "/config")[2].body, { thinkingLevel: "medium" }, "an unset level counts as low");
  });
});

test("Shift+Tab without an agent does nothing", async () => {
  await withApp({}, async (ctx) => {
    ctx.type(SHIFT_TAB);
    await settle();
    assert.equal(ctx.device.requests.length, 0);
  });
});

test("a failed thinking change is flashed", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.injections.push({ match: (r) => r.path.endsWith("/config"), status: 400, code: "invalid", message: "model cannot reason" });
    ctx.type(SHIFT_TAB);
    await until(() => ctx.status().includes("model cannot reason"), "the error");
  });
});

test("Ctrl+L opens the model picker and choosing a model configures the agent", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.type(CTRL_L);
    await until(() => overlays(ctx) === 1, "the picker");
    await settle();
    assert.match(ctx.term.screen(), /Model \(fake\)/);
    ctx.type("\x1b[B"); // from the current model (Beta Two) down wraps to Alpha One
    ctx.type(ENTER);
    await until(() => calls(ctx, "PATCH", "/config").length === 1, "config patch");
    assert.deepEqual(calls(ctx, "PATCH", "/config")[0].body, { model: { provider: "faux", modelId: "alpha-1" } });
    await until(() => ctx.status().includes("Model: Alpha One (next turn)"), "the note");
    assert.equal(overlays(ctx), 0);
  });
});

test("Ctrl+O toggles expanded tool output and thinking", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    assert.equal(priv(ctx).view.expand, false);
    ctx.type(CTRL_O);
    assert.equal(priv(ctx).view.expand, true);
    ctx.type(CTRL_O);
    assert.equal(priv(ctx).view.expand, false);
  });
});

test("Ctrl+C clears typed text, then exits on an empty editor", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.typeText("draft");
    ctx.type(CTRL_C);
    assert.equal(priv(ctx).editor.getText(), "");
    assert.deepEqual(ctx.exits, []);
    ctx.type(CTRL_C);
    assert.deepEqual(ctx.exits, [0]);
  });
});

test("Ctrl+C closes an open overlay first", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.app.sessionSummary() !== undefined, "session summary");
    pickAgent(ctx.app);
    assert.equal(overlays(ctx), 1);
    ctx.typeText("x"); // goes to the picker, not the editor
    assert.equal(priv(ctx).editor.getText(), "");
    ctx.type(CTRL_C);
    assert.equal(overlays(ctx), 0);
    assert.deepEqual(ctx.exits, []);
  });
});

test("Ctrl+D exits only from an empty editor and not while an overlay is open", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.typeText("abc");
    ctx.type(CTRL_D);
    assert.deepEqual(ctx.exits, []);
    ctx.type(CTRL_C);
    await until(() => ctx.app.sessionSummary() !== undefined, "session summary");
    pickAgent(ctx.app);
    ctx.type(CTRL_D);
    assert.deepEqual(ctx.exits, [], "an overlay swallows keys");
    ctx.type(CTRL_C);
    ctx.type(CTRL_D);
    assert.deepEqual(ctx.exits, [0]);
  });
});

test("keys other than the app's own reach the editor", async () => {
  await withApp({}, async (ctx) => {
    ctx.typeText("plain text");
    assert.equal(priv(ctx).editor.getText(), "plain text");
  });
});

// ------------------------------------------------------------------ overlays and prompt

test("closeOverlay with nothing open refocuses the editor, and can exit", async () => {
  await withApp({}, async (ctx) => {
    ctx.app.closeOverlay();
    assert.deepEqual(ctx.exits, []);
    ctx.app.closeOverlay(true);
    assert.deepEqual(ctx.exits.length, 1);
  });
});

test("prompt resolves with the trimmed text on Enter and undefined on Esc", async () => {
  await withApp({}, async (ctx) => {
    const answer = ctx.app.prompt("Name it", "");
    assert.equal(overlays(ctx), 1);
    ctx.typeText("  my name ");
    ctx.type(ENTER);
    assert.equal(await answer, "my name");
    assert.equal(overlays(ctx), 0);

    const cancelled = ctx.app.prompt("Name it", "");
    ctx.typeText("x");
    ctx.type(ESC);
    assert.equal(await cancelled, undefined);
    assert.equal(overlays(ctx), 0);
  });
});

// ------------------------------------------------------------------ exit and reattach

test("exit stops the TUI, closes the streams and prints the reattach command with names", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.header().includes("agent Main"), "session summary");
    ctx.exit();
    assert.deepEqual(ctx.exits, [0]);
    assert.match(reattachHint(ctx), /The agent keeps running on fake\. Reattach:\s+just tui attach fake:triage:main/);
    await until(() => ctx.device.openAgentStreams === 0 && ctx.device.openSessionStreams === 0, "streams closed");
  });
});

test("the reattach command names a named agent, and falls back to ids for unnamed ones", async () => {
  await withApp({ open: ["triage", "alt-path"] }, async (ctx) => {
    await until(() => ctx.header().includes("fork ⑂ alt-path"), "lineage");
    ctx.exit();
    assert.match(reattachHint(ctx), /just tui attach fake:triage:alt-path$/);
  });
  await withApp({ open: ["triage", "helper"] }, async (ctx) => {
    await until(() => ctx.header().includes("subagent"), "lineage");
    ctx.exit();
    assert.match(reattachHint(ctx), /just tui attach fake:triage:3$/, "an unnamed non-root agent is its id");
  });
});

test("names that are ambiguous or unusable on the command line are replaced by ids", async () => {
  // a colon in the session name, a clash between two sessions' names ignoring case, a quote in the agent name
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.sessions[0].name = "a:b";
    await ctx.app.open("a:b");
    await until(() => ctx.app.sessionSummary()?.name === "a:b", "renamed session in the tree");
    ctx.exit();
    assert.match(reattachHint(ctx), new RegExp(`just tui attach fake:${SID}:main$`));
  });
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.sessions.push(session("44444444-dddd-4ddd-8ddd-444444444444", "TRIAGE"));
    await ctx.app.attach(SID, 1); // refresh the session list
    await until(() => (priv(ctx).sessions as unknown[]).length === 3, "three sessions");
    await until(() => ctx.header().includes("agent Main"), "header");
    ctx.exit();
    assert.match(reattachHint(ctx), new RegExp(`just tui attach fake:${SID}:main$`), "'triage' and 'TRIAGE' clash");
  });
  await withApp({ open: ["triage", "alt-path"] }, async (ctx) => {
    ctx.device.sessions[0].agents[1].name = "it's";
    await ctx.app.attach(SID, 2);
    await until(() => ctx.header().includes("it's"), "renamed agent");
    ctx.exit();
    assert.match(reattachHint(ctx), /just tui attach fake:triage:2$/);
  });
});

test("a name with spaces makes the whole reference one quoted shell word", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    ctx.device.sessions[0].name = "my session";
    await ctx.app.attach(SID, 1);
    await until(() => ctx.app.sessionSummary()?.name === "my session" && ctx.header().includes("agent Main"), "renamed");
    ctx.exit();
    assert.match(reattachHint(ctx), /just tui attach 'fake:my session:main'$/);
  });
});

test("an ad hoc device is reattached with --url and a token placeholder", async () => {
  await withApp({ open: ["triage"], deviceRef: { id: "adhoc", name: "127.0.0.1:9999" } }, async (ctx) => {
    await until(() => ctx.header().includes("agent Main"), "session summary");
    ctx.exit();
    const hint = reattachHint(ctx).replace(/\s+/g, " ");
    assert.ok(hint.includes("The agent keeps running on 127.0.0.1:9999. Reattach:"), hint);
    assert.ok(hint.includes(`just tui attach --url ${ctx.device.url} --token <token> -s triage -a main`), hint);
  });
});

test("exit without a session prints no reattach command", async () => {
  await withApp({}, async (ctx) => {
    ctx.exit();
    assert.deepEqual(ctx.exits, [0]);
    assert.equal(reattachHint(ctx), "");
  });
});

// ------------------------------------------------------------------ switching devices

test("switchDevice moves to another device and opens its session picker", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    const { startFakeDevice } = await import("./support/fake-device.ts");
    const other = await startFakeDevice();
    other.info = { ...other.info, name: "other", models: other.info.models };
    try {
      ctx.registry.upsert({ id: "other", name: "Other", kind: "url", url: other.url, token: "o".repeat(40) });
      await ctx.app.switchDevice("other");
      assert.equal(ctx.app.device.id, "other");
      assert.equal(ctx.app.sessionId, undefined);
      assert.equal(ctx.app.handle, undefined);
      assert.match(ctx.header(), /^dpi  │  device other  │  no workspace/);
      assert.equal(overlays(ctx), 1, "the picker for the new device");
      await until(() => ctx.device.openAgentStreams === 0, "old streams closed");
      assert.ok(other.seen("GET /v1/device").length === 1 && other.seen("GET /v1/tree").length === 1);
    } finally {
      await other.close();
    }
  });
});

test("switchDevice needs a registry token, and a device that is down leaves everything as it was", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await ctx.app.switchDevice("nobody");
    assert.deepEqual(ctx.status(), ["No token for nobody. Run: just net register nobody"]);
    ctx.registry.upsert({ id: "tokenless", kind: "url", url: "http://127.0.0.1:1" });
    await ctx.app.switchDevice("tokenless");
    assert.deepEqual(ctx.status(), ["No token for tokenless. Run: just net register tokenless"]);

    ctx.registry.upsert({ id: "down", kind: "url", url: "http://127.0.0.1:1", token: "d".repeat(40) });
    await ctx.app.switchDevice("down");
    assert.match(ctx.status()[0], /Cannot reach http:\/\/127\.0\.0\.1:1/);
    assert.equal(ctx.app.device.id, "fake", "still on the old device");
    assert.equal(ctx.app.sessionId, SID);
    assert.equal(ctx.device.openAgentStreams, 1, "streams untouched");
  });
});

// ------------------------------------------------------------------ session summary

test("sessionSummary uses the live agent list once the session stream is ready", async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    await until(() => ctx.app.sessionSummary()?.agents.length === 3, "summary");
    const fresh: AgentSummary[] = [agent(1), agent(9, { name: "new fork", kind: "fork", parentId: 1, forkedAt: 3 })];
    await pushSession(ctx, { type: "agents", agents: fresh });
    assert.deepEqual(ctx.app.sessionSummary()!.agents.map((a) => a.id), [1, 9]);
    assert.equal(ctx.app.sessionSummary()!.name, "triage");
  });
  await withApp({}, async (ctx) => {
    assert.equal(ctx.app.sessionSummary(), undefined);
  });
});

// Suspected bug (source left alone): switchDevice resets the session, agent and models but not `connection`, so the
// header of the new device, which has no agent attached yet, still says "● live" (or "offline") from the old one.
test("after switching device the header does not claim a live connection", { todo: "switchDevice does not reset the connection state" }, async () => {
  await withApp({ open: ["triage"] }, async (ctx) => {
    const { startFakeDevice } = await import("./support/fake-device.ts");
    const other = await startFakeDevice();
    try {
      ctx.registry.upsert({ id: "other", name: "Other", kind: "url", url: other.url, token: "o".repeat(40) });
      await ctx.app.switchDevice("other");
      assert.match(ctx.header(), /○ no agent$/);
    } finally {
      await other.close();
    }
  });
});
