import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.ts";
import { COMMANDS, runCommand } from "../src/commands.ts";
import { Panel, Picker } from "../src/pickers.ts";
import { FakeApp } from "./support/fake-app.ts";
import { agent, session, settle } from "./support/fake-device.ts";
import { strip } from "./support/fake-terminal.ts";

const text = (component: { render(width: number): string[] } | undefined, width = 100) => strip((component?.render(width) ?? []).join("\n"));

test("the command table lists every documented command with a description", () => {
  assert.deepEqual(
    COMMANDS.map((c) => c.name),
    ["sessions", "agents", "model", "devices", "new", "fork", "thinking", "compact", "reset", "name", "tasks", "help", "quit"],
  );
  for (const command of COMMANDS) assert.ok(command.description, `/${command.name} has a description`);
});

test("/thinking completes level names by prefix", async () => {
  const thinking = COMMANDS.find((c) => c.name === "thinking")!;
  const complete = (prefix: string) => thinking.getArgumentCompletions!(prefix) as { value: string; label: string }[];
  assert.deepEqual(complete("").map((x) => x.value), [...THINKING_LEVELS]);
  assert.deepEqual(complete("m").map((x) => x.value), ["minimal", "medium"]);
  assert.deepEqual(complete("x"), [{ value: "xhigh", label: "xhigh" }]);
  assert.deepEqual(complete("zzz"), []);
});

// ------------------------------------------------------------------ what is a command

test("text that is not a known command goes back to the caller untouched", async () => {
  const app = new FakeApp();
  for (const input of ["hello", "/unknown arg", "/", "/ sessions", "/Sessions", "/usr/bin/env is a path", " /help", "run /help please"]) {
    assert.equal(await runCommand(app.asApp, input), false, JSON.stringify(input));
  }
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.flashes, []);
  assert.equal(app.overlays.length, 0);
});

test("a command name is matched exactly, and the rest of the line is its argument", async () => {
  const app = new FakeApp();
  assert.equal(await runCommand(app.asApp, "/help"), true);
  assert.equal(await runCommand(app.asApp, "/helpme"), false, "a longer word is not /help");
  assert.equal(await runCommand(app.asApp, "/help   with extra words"), true, "arguments to /help are ignored");
  assert.equal(app.overlays.length, 2);
});

// ------------------------------------------------------------------ /new

test("/new creates an agent in the current session and attaches to it", async () => {
  const app = new FakeApp();
  assert.equal(await runCommand(app.asApp, "/new"), true);
  assert.deepEqual(app.args("createAgent"), [[{}]], "no name, empty body");
  assert.deepEqual(app.attached, [["s1", 5]]);
  assert.deepEqual(app.flashes, [{ text: "New agent Agent 5", error: false }]);
});

test("/new <name> trims the name and passes it on whole", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/new   review the diff  ");
  assert.deepEqual(app.args("createAgent"), [[{ name: "review the diff" }]]);
  assert.deepEqual(app.flashes, [{ text: "New agent review the diff", error: false }]);
});

test("/new reports a failure and does not attach", async () => {
  const app = new FakeApp();
  app.failing.set("createAgent", new Error("session is archived"));
  assert.equal(await runCommand(app.asApp, "/new x"), true);
  assert.deepEqual(app.attached, []);
  assert.deepEqual(app.flashes, [{ text: "session is archived", error: true }]);
});

// ------------------------------------------------------------------ /fork

test("/fork with no argument forks at the last assistant reply", async () => {
  const app = new FakeApp();
  app.entries = [
    { id: 1, kind: "pi.user" },
    { id: 2, kind: "pi.assistant" },
    { id: 3, kind: "pi.tool-result" },
    { id: 4, kind: "pi.assistant" },
    { id: 5, kind: "pi.user" },
  ];
  await runCommand(app.asApp, "/fork");
  assert.deepEqual(app.args("fork"), [[{ entryId: 4, name: undefined }]]);
  assert.deepEqual(app.attached, [["s1", 7]]);
  assert.deepEqual(app.flashes, [{ text: "Forked at #4 → Fork 7", error: false }]);
});

test("/fork <entryId> forks there; the rest of the line is the name", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/fork 12");
  await runCommand(app.asApp, "/fork 3 try   a   second approach");
  assert.deepEqual(app.args("fork"), [
    [{ entryId: 12, name: undefined }],
    [{ entryId: 3, name: "try a second approach" }],
  ]);
  assert.equal(app.flashes[1].text, "Forked at #3 → try a second approach");
});

test("/fork <name> with a non-numeric first word forks at the last reply and uses every word as the name", async () => {
  const app = new FakeApp();
  app.entries = [{ id: 9, kind: "pi.assistant" }];
  await runCommand(app.asApp, "/fork alt path");
  assert.deepEqual(app.args("fork"), [[{ entryId: 9, name: "alt path" }]]);
  await runCommand(app.asApp, "/fork 7abc");
  assert.deepEqual(app.args("fork")[1], [{ entryId: 9, name: "7abc" }], "digits followed by letters are a name, not an id");
});

test("/fork 0 is an explicit entry id, not 'missing'", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/fork 0");
  assert.deepEqual(app.args("fork"), [[{ entryId: 0, name: undefined }]]);
});

test("/fork with nothing to fork says so and makes no call", async () => {
  const app = new FakeApp();
  app.entries = [{ id: 1, kind: "pi.user" }];
  assert.equal(await runCommand(app.asApp, "/fork"), true);
  assert.equal(await runCommand(app.asApp, "/fork some name"), true);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.flashes, [
    { text: "Nothing to fork yet.", error: true },
    { text: "Nothing to fork yet.", error: true },
  ]);
});

test("/fork reports a failure and does not attach", async () => {
  const app = new FakeApp();
  app.failing.set("fork", new Error("unknown entry"));
  await runCommand(app.asApp, "/fork 99");
  assert.deepEqual(app.attached, []);
  assert.deepEqual(app.flashes, [{ text: "unknown entry", error: true }]);
});

// ------------------------------------------------------------------ /thinking, /compact, /reset, /name

test("/thinking accepts each level and configures the agent", async () => {
  const app = new FakeApp();
  for (const level of THINKING_LEVELS) assert.equal(await runCommand(app.asApp, `/thinking ${level}`), true);
  assert.deepEqual(
    app.args("configure"),
    THINKING_LEVELS.map((thinkingLevel) => [{ thinkingLevel }]),
  );
  assert.deepEqual(app.flashes, []);
});

test("/thinking rejects a missing or unknown level and lists the valid ones", async () => {
  const app = new FakeApp();
  for (const input of ["/thinking", "/thinking ultra", "/thinking HIGH", "/thinking high now"]) await runCommand(app.asApp, input);
  assert.deepEqual(app.calls, []);
  assert.equal(app.flashes.length, 4);
  for (const f of app.flashes) assert.deepEqual(f, { text: `Levels: ${THINKING_LEVELS.join(", ")}`, error: true });
});

test("/thinking reports a failed configure", async () => {
  const app = new FakeApp();
  app.failing.set("configure", new Error("model has no reasoning"));
  await runCommand(app.asApp, "/thinking high");
  assert.deepEqual(app.flashes, [{ text: "model has no reasoning", error: true }]);
});

test("/compact passes optional instructions", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/compact");
  await runCommand(app.asApp, "/compact  keep the failing test names ");
  assert.deepEqual(app.args("compact"), [[undefined], ["keep the failing test names"]]);
  assert.deepEqual(app.flashes.map((f) => f.text), ["Compaction requested", "Compaction requested"]);
});

test("/reset passes an optional handoff note", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/reset");
  await runCommand(app.asApp, "/reset  continue with the parser ");
  assert.deepEqual(app.args("reset"), [[undefined], ["continue with the parser"]]);
  assert.deepEqual(app.flashes.map((f) => f.text), ["New context started; history stays stored", "New context started; history stays stored"]);
});

test("/compact and /reset report failures instead of the success note", async () => {
  const app = new FakeApp();
  app.failing.set("compact", new Error("already compacting"));
  app.failing.set("reset", new Error("agent is busy"));
  await runCommand(app.asApp, "/compact");
  await runCommand(app.asApp, "/reset");
  assert.deepEqual(app.flashes, [
    { text: "already compacting", error: true },
    { text: "agent is busy", error: true },
  ]);
});

test("/name renames the agent, and needs a name", async () => {
  const app = new FakeApp();
  assert.equal(await runCommand(app.asApp, "/name"), true);
  assert.equal(await runCommand(app.asApp, "/name    "), true);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.flashes, [
    { text: "Usage: /name <name>", error: true },
    { text: "Usage: /name <name>", error: true },
  ]);
  app.flashes.length = 0;
  await runCommand(app.asApp, "/name  the fixer ");
  assert.deepEqual(app.args("rename"), [["the fixer"]]);
  assert.deepEqual(app.flashes, [{ text: "Agent renamed to the fixer", error: false }]);
});

// ------------------------------------------------------------------ panels

test("/tasks opens a panel that says when there are none", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/tasks");
  assert.ok(app.top instanceof Panel);
  const out = text(app.top);
  assert.match(out, /Live tasks in triage/);
  assert.match(out, /No live tasks\./);
  assert.match(out, /esc close/);
});

test("/tasks lists foreground and background tasks with agent, status and phase", async () => {
  const app = new FakeApp();
  app.tasks = [
    { id: 4, kind: "pi.tool", conversationId: 1, background: false, state: { status: "running", phase: "exec" }, conversations: [1] },
    { id: 9, kind: "job", conversationId: 2, background: true, state: { status: "waiting" }, conversations: [2] },
  ];
  await runCommand(app.asApp, "/tasks");
  const lines = text(app.top).split("\n").map((l) => l.trim());
  assert.ok(lines.some((l) => l.includes("● fg #4 pi.tool agent #1 │ running/exec")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("◌ bg #9 job agent #2 │ waiting") && !l.includes("waiting/")), lines.join("\n"));
  assert.ok(!text(app.top).includes("No live tasks."));
});

test("/tasks rereads the tasks each time it renders, and falls back to 'session' without a summary", async () => {
  const app = new FakeApp();
  app.summary = undefined;
  await runCommand(app.asApp, "/tasks");
  assert.match(text(app.top), /Live tasks in session/);
  app.tasks = [{ id: 1, kind: "k", conversationId: 1, background: false, state: { status: "running" }, conversations: [] }];
  assert.match(text(app.top), /● fg #1 k/);
});

test("/help shows the device, every key and every command", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/help");
  const out = text(app.top, 120);
  assert.match(out, /dev │ http:\/\/dev\.test:4780/);
  for (const key of ["enter", "alt+enter", "esc", "shift+tab", "ctrl+l", "ctrl+o", "ctrl+c", "ctrl+d"]) assert.ok(out.includes(key), key);
  for (const command of COMMANDS) assert.ok(out.includes(`/${command.name}`), command.name);
  assert.match(out, /Closing dpi-tui never stops the agent/);
});

test("panels never draw past the width", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/help");
  for (const width of [20, 40, 80]) for (const line of strip(app.top!.render(width).join("\n")).split("\n")) assert.ok([...line].length <= width, `${width}: ${line}`);
});

test("a panel closes on esc, enter and q, and ignores other keys", async () => {
  const app = new FakeApp();
  await runCommand(app.asApp, "/help");
  const panel = app.top as Panel;
  panel.handleInput("x");
  panel.handleInput("\x1b[A");
  assert.deepEqual(app.closed, []);
  for (const key of ["\x1b", "\r", "q"]) panel.handleInput(key);
  assert.deepEqual(app.closed, [false, false, false]);
});

// ------------------------------------------------------------------ pickers and quit

test("/quit exits", async () => {
  const app = new FakeApp();
  assert.equal(await runCommand(app.asApp, "/quit"), true);
  assert.equal(app.exited, 1);
});

test("/sessions, /agents, /model and /devices open their pickers", async () => {
  const app = new FakeApp();
  app.trees = [session("s1", "triage", [agent(1)])];
  app.agentModel = { provider: "faux", modelId: "beta-2" };
  assert.equal(await runCommand(app.asApp, "/sessions"), true);
  assert.ok(app.top instanceof Picker);
  assert.match(text(app.top), /Sessions on dev/);
  await runCommand(app.asApp, "/agents");
  assert.match(text(app.top), /Agents in triage/);
  const modelDone = runCommand(app.asApp, "/model"); // resolves once the picker is answered
  await settle(0);
  assert.match(text(app.top), /Model \(dev\)/);
  (app.top as Picker).handleInput("\x1b");
  assert.equal(await modelDone, true);
  await runCommand(app.asApp, "/devices");
  assert.deepEqual(app.flashes, [{ text: "No saved devices. Use --url/--token --save <id>.", error: true }]);
});

// ------------------------------------------------------------------ no session attached

test("commands that act on an agent say so when no session is attached, and send nothing", async () => {
  const app = new FakeApp();
  app.handle = undefined;
  app.sessionId = undefined;
  for (const input of ["/thinking high", "/compact", "/reset", "/name x", "/fork 3", "/new", "/new x"]) assert.equal(await runCommand(app.asApp, input), true, input);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.attached, []);
  assert.equal(app.flashes.length, 7);
  for (const f of app.flashes) assert.deepEqual(f, { text: "Pick a session first (/sessions).", error: true });
});
