import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { Panel, Picker, Prompt, newSession, pickAgent, pickDevice, pickModel, pickSession } from "../src/pickers.ts";
import { FakeApp } from "./support/fake-app.ts";
import { agent, MODELS, session, settle } from "./support/fake-device.ts";
import { strip } from "./support/fake-terminal.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

const lines = (c: { render(width: number): string[] } | undefined, width = 100) => strip((c?.render(width) ?? []).join("\n")).split("\n").map((l) => l.trimEnd());
const picker = (app: FakeApp) => {
  assert.ok(app.top instanceof Picker, "a picker is open");
  return app.top;
};
/** The visible rows of a picker: title, one line per item, then the hint. */
const rows = (p: Picker) => lines(p).filter((l) => l.trim());
/** Item labels only: the rows between title and hint, without the selection arrow or the description column. */
const labels = (p: Picker) =>
  rows(p)
    .slice(1, -1)
    .map((l) => l.replace(/^\s*→?\s*/, "").replace(/\s{2,}.*$/, ""));
const indent = (line: string) => {
  const flat = line.replace("→", " ");
  return flat.length - flat.trimStart().length;
};

// ------------------------------------------------------------------ Picker

const items: SelectItem[] = [
  { value: "apple", label: "apple", description: "fruit" },
  { value: "banana", label: "banana", description: "fruit" },
  { value: "carrot", label: "carrot", description: "vegetable" },
];

test("Picker shows its title, items, descriptions and hint; enter picks the selected item", () => {
  const picked: string[] = [];
  const p = new Picker("Fruit", items, (i) => picked.push(i.value), () => assert.fail("not cancelled"));
  const out = lines(p).join("\n");
  for (const text of ["Fruit", "apple", "banana", "carrot", "vegetable", "↑↓ move │ enter select │ type to filter │ esc close"]) assert.ok(out.includes(text), text);
  p.handleInput(DOWN);
  p.handleInput(ENTER);
  assert.deepEqual(picked, ["banana"]);
});

test("Picker takes a custom hint and cancels on esc", () => {
  let cancelled = 0;
  const p = new Picker("T", items, () => {}, () => cancelled++, "custom hint");
  assert.ok(lines(p).join("\n").includes("custom hint"));
  p.handleInput(ESC);
  assert.equal(cancelled, 1);
});

test("typing filters the picker, backspace widens it again, and the title shows the filter", () => {
  const picked: string[] = [];
  const p = new Picker("Fruit", items, (i) => picked.push(i.value), () => {});
  for (const ch of "car") p.handleInput(ch);
  let out = lines(p).join("\n");
  assert.match(out, /Fruit\s+\/car/);
  assert.ok(out.includes("carrot"));
  assert.ok(!out.includes("apple") && !out.includes("banana"), out);
  p.handleInput(ENTER);
  assert.deepEqual(picked, ["carrot"]);

  p.handleInput(BACKSPACE);
  p.handleInput(BACKSPACE);
  p.handleInput(BACKSPACE);
  out = lines(p).join("\n");
  assert.ok(out.includes("apple") && out.includes("banana") && out.includes("carrot"));
  assert.ok(!out.includes("/"), "the filter marker is gone with an empty filter");
  p.handleInput(BACKSPACE); // already empty
  assert.ok(lines(p).join("\n").includes("apple"));
});

test("typing part of a visible label finds the item even when its value is an id", () => {
  const picked: string[] = [];
  const sessions: SelectItem[] = [
    { value: "9f1c2d3e-0000-4000-8000-000000000001", label: "triage", description: "work/triage │ 3 agents" },
    { value: "7a0b1c2d-0000-4000-8000-000000000002", label: "review", description: "srv/review │ 1 agent" },
  ];
  const p = new Picker("Sessions", sessions, (i) => picked.push(i.label), () => {});
  for (const ch of "rev") p.handleInput(ch);
  p.handleInput(ENTER);
  assert.deepEqual(picked, ["review"]);
});

test("the filter ignores case, matches inside a label, and still matches the start of the value", () => {
  const picked: string[] = [];
  const list: SelectItem[] = [
    { value: "9f1c-uuid", label: "  ⑂ Alt Path" },
    { value: "7a0b-uuid", label: "triage" },
  ];
  const pick = (typed: string) => {
    const p = new Picker("T", list, (i) => picked.push(i.label.trim()), () => {});
    for (const ch of typed) p.handleInput(ch);
    p.handleInput(ENTER);
  };
  pick("alt p");
  pick("AGE");
  pick("7a0b");
  assert.deepEqual(picked, ["⑂ Alt Path", "triage", "triage"]);
});

test("a filter that matches nothing shows the empty message and enter picks nothing", () => {
  const picked: string[] = [];
  const p = new Picker("Fruit", items, (i) => picked.push(i.value), () => {});
  for (const ch of "zzzz") p.handleInput(ch);
  assert.ok(!lines(p).join("\n").includes("apple"));
  p.handleInput(ENTER);
  assert.deepEqual(picked, []);
});

test("a Picker never draws past its width, even with long wide labels", () => {
  const long: SelectItem[] = [{ value: "x", label: "漢字".repeat(60), description: "🙂".repeat(80) }];
  const p = new Picker("標題".repeat(30), long, () => {}, () => {});
  for (const width of [20, 40, 80]) for (const line of p.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
});

// ------------------------------------------------------------------ Prompt

test("Prompt starts with its initial text, edits it, submits on enter and cancels on esc", () => {
  const events: string[] = [];
  const p = new Prompt("Name", "abc", (v) => events.push(`submit:${v}`), () => events.push("cancel"));
  assert.ok(lines(p).join("\n").includes("Name"));
  assert.ok(lines(p).join("\n").includes("abc"));
  assert.ok(lines(p).join("\n").includes("enter confirm │ esc cancel"));
  assert.equal(p.input.getValue(), "abc");
  p.handleInput(ENTER);
  const typed = new Prompt("Name", "", (v) => events.push(`submit:${v}`), () => events.push("cancel"));
  for (const ch of "abd") typed.handleInput(ch);
  typed.handleInput(BACKSPACE);
  typed.handleInput("c");
  typed.handleInput(ENTER);
  typed.handleInput(ESC);
  assert.deepEqual(events, ["submit:abc", "submit:abc", "cancel"]);
});

test("Prompt passes focus to its input", () => {
  const p = new Prompt("Name", "", () => {}, () => {});
  assert.equal(p.focused, false);
  p.focused = true;
  assert.equal(p.focused, true);
  assert.equal(p.input.focused, true);
  p.focused = false;
  assert.equal(p.input.focused, false);
});

// ------------------------------------------------------------------ Panel

test("Panel renders its lines at the width given, truncated, and closes on esc/enter/q only", () => {
  let closed = 0;
  const panel = new Panel((width) => [`wide ${"x".repeat(200)}`, `width=${width}`], () => closed++);
  const out = lines(panel, 30);
  assert.ok(out.every((l) => l.length <= 30), out.join("\n"));
  assert.ok(out.some((l) => l.includes("width=")), "the body is asked for its lines at render time");
  for (const key of ["a", " ", DOWN]) panel.handleInput(key);
  assert.equal(closed, 0);
  for (const key of [ESC, ENTER, "q"]) panel.handleInput(key);
  assert.equal(closed, 3);
});

// ------------------------------------------------------------------ pickSession

const triage = session("sid-triage", "triage", [agent(2, { name: "alt", kind: "fork", parentId: 1 }), agent(1), agent(3)], { cwd: "/home/u/work/triage" });
const review = session("sid-review", "review", [agent(4, { kind: "root" })], { busy: true, cwd: "/srv/review" });

test("pickSession lists '＋ New session' first, then each session with its directory, agent count and busy mark", async () => {
  const app = new FakeApp();
  app.trees = [triage, review];
  await pickSession(app.asApp);
  const out = rows(picker(app));
  assert.match(out[0], /Sessions on dev/);
  assert.match(out[1], /＋ New session\s+choose a directory on dev/);
  assert.match(out[2], /triage\s+work\/triage │ 3 agents/);
  assert.match(out[3], /review\s+srv\/review │ 1 agent │ working/);
  assert.ok(!/1 agents/.test(out[3]), "singular for one agent");
});

test("picking a session attaches to its root agent (not the first listed), falling back to the first agent, then #1", async () => {
  const app = new FakeApp();
  const noRoot = session("sid-x", "noroot", [agent(8, { kind: "fork" }), agent(9, { kind: "subagent" })]);
  const empty = session("sid-e", "empty", []);
  app.trees = [triage, noRoot, empty];
  await pickSession(app.asApp);
  const p = picker(app);
  p.handleInput(DOWN); // triage
  p.handleInput(ENTER);
  assert.deepEqual(app.closed, [false]);
  assert.deepEqual(app.attached, [["sid-triage", 1]]);

  await pickSession(app.asApp);
  for (const _ of [1, 2]) picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER);
  assert.deepEqual(app.attached.at(-1), ["sid-x", 8]);

  await pickSession(app.asApp);
  for (const _ of [1, 2, 3]) picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER);
  assert.deepEqual(app.attached.at(-1), ["sid-e", 1]);
});

test("cancelling the session picker closes it, and exits only when no session is attached yet", async () => {
  const app = new FakeApp();
  app.trees = [triage];
  await pickSession(app.asApp);
  picker(app).handleInput(ESC);
  assert.deepEqual(app.closed, [false]);
  assert.equal(app.exited, 0);

  app.sessionId = undefined;
  await pickSession(app.asApp);
  picker(app).handleInput(ESC);
  assert.deepEqual(app.closed, [false, true]);
  assert.equal(app.exited, 1);
});

// ------------------------------------------------------------------ newSession

function directories(app: FakeApp) {
  app.dirs = {
    "": { path: "", dirs: [{ name: "work", path: "/work" }, { name: "play", path: "/play" }] },
    "/work": { path: "/work", parent: "", dirs: [{ name: "app", path: "/work/app" }] },
    "/work/app": { path: "/work/app", parent: "/work", dirs: [] },
  };
}

test("newSession asks for a name, walks to a directory, picks a model and creates the session", async () => {
  const app = new FakeApp();
  directories(app);
  app.promptAnswers = ["my session"];
  const done = newSession(app.asApp);
  await settle(0);
  assert.deepEqual(app.prompts, [{ label: "Session name", initial: "" }]);

  // start dirs: no "use" row at the top level
  assert.match(rows(picker(app))[0], /Working directory on dev/);
  assert.deepEqual(labels(picker(app)), ["work/", "play/"]);
  picker(app).handleInput(ENTER); // work/
  await settle(0);

  assert.deepEqual(labels(picker(app)), ["✓ Use /work", "⌂ start dirs", "app/"], ".. is shown as start dirs when the parent is empty");
  picker(app).handleInput(DOWN);
  picker(app).handleInput(DOWN); // app/
  picker(app).handleInput(ENTER);
  await settle(0);

  assert.deepEqual(labels(picker(app)), ["✓ Use /work/app", ".."], "a nested directory offers .. to its parent");
  picker(app).handleInput(ENTER); // use /work/app
  await settle(0);

  // model picker: default model is preselected
  const out = rows(picker(app));
  assert.match(out[0], /Model \(dev\)/);
  assert.match(out[1], /Alpha One\s+fast │ faux/);
  assert.match(out[2], /→ Beta Two\s+smart │ faux/, "the device's default model is preselected");
  picker(app).handleInput(ENTER);
  await done;

  assert.deepEqual(app.args("createSession"), [[{ name: "my session", cwd: "/work/app", model: { provider: "faux", modelId: "beta-2" } }]]);
  assert.deepEqual(app.attached, [["new-id", 1]]);
  assert.deepEqual(app.flashes, [{ text: "Session created in /work/app", error: false }]);
  assert.equal(app.overlays.length, 0, "every overlay was closed");
});

test("the '..' row of a nested directory goes up, and 'use' picks the directory shown", async () => {
  const app = new FakeApp();
  directories(app);
  app.promptAnswers = [""];
  const done = newSession(app.asApp);
  await settle(0);
  picker(app).handleInput(ENTER); // work/
  await settle(0);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER); // app/
  await settle(0);
  assert.deepEqual(labels(picker(app)), ["✓ Use /work/app", ".."]);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER); // .. → /work
  await settle(0);
  assert.deepEqual(labels(picker(app)), ["✓ Use /work", "⌂ start dirs", "app/"]);
  picker(app).handleInput(ENTER); // use /work
  await settle(0);
  picker(app).handleInput(ESC); // no model chosen
  await done;
  assert.deepEqual(app.args("createSession"), [], "cancelling the model picker creates nothing");
  assert.deepEqual(app.attached, []);
});

test("an empty session name becomes 'New session'", async () => {
  const app = new FakeApp();
  directories(app);
  app.promptAnswers = [""];
  const done = newSession(app.asApp);
  await settle(0);
  picker(app).handleInput(ENTER);
  await settle(0);
  picker(app).handleInput(ENTER); // use /work
  await settle(0);
  picker(app).handleInput(ENTER); // default model
  await done;
  assert.equal((app.args("createSession")[0][0] as { name: string }).name, "New session");
});

test("cancelling the name prompt returns to the session list only when nothing is attached", async () => {
  const app = new FakeApp();
  app.trees = [triage];
  app.promptAnswers = [undefined];
  await newSession(app.asApp);
  assert.equal(app.overlays.length, 0, "attached: just stop");

  app.sessionId = undefined;
  app.promptAnswers = [undefined];
  await newSession(app.asApp);
  assert.match(lines(app.top).join("\n"), /Sessions on dev/);
});

test("cancelling the directory picker, or a failing directory listing, returns the same way and creates nothing", async () => {
  const app = new FakeApp();
  directories(app);
  app.trees = [triage];
  app.promptAnswers = ["x"];
  const first = newSession(app.asApp);
  await settle(0);
  picker(app).handleInput(ESC);
  await first;
  assert.equal(app.overlays.length, 0);

  app.sessionId = undefined;
  app.dirs = {}; // every listing now fails
  app.promptAnswers = ["x"];
  await newSession(app.asApp);
  assert.deepEqual(app.flashes.at(-1), { text: "No such directory: ", error: true });
  assert.match(lines(app.top).join("\n"), /Sessions on dev/);
  assert.deepEqual(app.args("createSession"), []);
});

// ------------------------------------------------------------------ pickModel

test("pickModel needs an attached agent", async () => {
  const app = new FakeApp();
  app.handle = undefined;
  await pickModel(app.asApp);
  assert.equal(app.overlays.length, 0);
});

test("pickModel preselects the agent's model and configures the chosen one for the next turn", async () => {
  const app = new FakeApp();
  app.agentModel = { provider: "faux", modelId: "beta-2" };
  const done = pickModel(app.asApp);
  await settle(0);
  picker(app).handleInput(DOWN); // from Beta Two (index 1) the list wraps to Alpha One
  picker(app).handleInput(ENTER);
  await done;
  assert.deepEqual(app.args("configure"), [[{ model: { provider: "faux", modelId: "alpha-1" } }]]);
  assert.deepEqual(app.flashes, [{ text: "Model: Alpha One (next turn)", error: false }]);
});

test("pickModel does nothing when cancelled and reports a failed configure", async () => {
  const app = new FakeApp();
  const cancelled = pickModel(app.asApp);
  await settle(0);
  picker(app).handleInput(ESC);
  await cancelled;
  assert.deepEqual(app.calls, []);

  app.failing.set("configure", new Error("unknown model"));
  const failed = pickModel(app.asApp);
  await settle(0);
  picker(app).handleInput(ENTER); // first model: nothing preselected
  await failed;
  assert.deepEqual(app.args("configure"), [[{ model: { provider: "faux", modelId: MODELS[0].id } }]]);
  assert.deepEqual(app.flashes, [{ text: "unknown model", error: true }]);
});

// ------------------------------------------------------------------ pickAgent

test("pickAgent nests forks and subagents under their parent with icons, busy and background marks", () => {
  const app = new FakeApp();
  app.agentId = 3;
  app.summary = session("s1", "triage", [
    agent(1, { busy: true }),
    agent(2, { name: "alt", kind: "fork", parentId: 1, forkedAt: 14 }),
    agent(3, { name: "deeper", kind: "fork", parentId: 2, forkedAt: 20 }),
    agent(4, { name: "helper", kind: "subagent", ownerAgentId: 1, background: 2 }),
  ]);
  pickAgent(app.asApp);
  const out = rows(picker(app));
  assert.match(out[0], /Agents in triage/);
  assert.match(out[1], /◆ Main ●\s+root/);
  assert.match(out[2], /⑂ alt\s+fork @ #14/);
  assert.match(out[3], /⑂ deeper\s+fork @ #20/);
  assert.match(out[4], /↳ helper\s+subagent │ 2 bg/);
  assert.equal(indent(out[2]), indent(out[1]) + 2, "a fork sits one level under its parent");
  assert.equal(indent(out[3]), indent(out[1]) + 4, "and a fork of a fork two levels");
  assert.equal(indent(out[4]), indent(out[1]) + 2, "a subagent sits under the agent that owns it");
  assert.match(out[3], /→/, "the current agent is preselected");
});

test("pickAgent preselects the current agent and attaches to the one chosen", () => {
  const app = new FakeApp();
  app.agentId = 2;
  app.summary = session("s1", "triage", [agent(1), agent(2, { name: "alt", parentId: 1, forkedAt: 1 }), agent(3, { name: "other", parentId: 1, forkedAt: 2 })]);
  pickAgent(app.asApp);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER);
  assert.deepEqual(app.attached, [["s1", 3]]);
  assert.deepEqual(app.closed, [false]);
});

test("pickAgent does nothing without a session summary, and esc just closes it", () => {
  const app = new FakeApp();
  app.summary = undefined;
  pickAgent(app.asApp);
  assert.equal(app.overlays.length, 0);
  app.summary = session("s1", "triage");
  pickAgent(app.asApp);
  picker(app).handleInput(ESC);
  assert.deepEqual(app.closed, [false]);
});

// ------------------------------------------------------------------ pickDevice

test("pickDevice says how to add a device when none are saved", () => {
  const app = new FakeApp();
  pickDevice(app.asApp);
  app.registry = { list: () => [] };
  pickDevice(app.asApp);
  assert.deepEqual(app.flashes, [
    { text: "No saved devices. Use --url/--token --save <id>.", error: true },
    { text: "No saved devices. Use --url/--token --save <id>.", error: true },
  ]);
  assert.equal(app.overlays.length, 0);
});

test("pickDevice marks the current device and tokenless devices, and switches to the one chosen", () => {
  const app = new FakeApp();
  app.registry = {
    list: () => [
      { id: "alpha", kind: "url", url: "https://alpha.test", token: "x".repeat(40) },
      { id: "dev", kind: "ssh", url: "http://dev.test:4780", token: "x".repeat(40) },
      { id: "gamma", kind: "exe-dev", url: "https://gamma.test", token: null },
    ],
  };
  pickDevice(app.asApp);
  const out = rows(picker(app));
  assert.match(out[0], /Devices/);
  assert.match(out[1], /alpha\s+url │ https:\/\/alpha\.test$/);
  assert.ok(!out[1].includes("●") && !out[1].includes("no token"));
  assert.match(out[2], /● dev\s+ssh │ http:\/\/dev\.test:4780$/);
  assert.match(out[3], /gamma\s+exe-dev │ https:\/\/gamma\.test │ no token$/);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(DOWN);
  picker(app).handleInput(ENTER);
  assert.deepEqual(app.switched, ["gamma"]);
  assert.deepEqual(app.closed, [false]);
});
