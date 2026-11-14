import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolCallView, TranscriptItem } from "../../dpi-sdk/src/transcript.ts";
import { itemComponent, Line, spinner, ToolRow, TranscriptView } from "../src/render.ts";
import { strip } from "./support/fake-terminal.ts";

const plain = (c: Component, width = 80) => c.render(width).map((l) => strip(l));
const call = (extra: Partial<ToolCallView> = {}): ToolCallView => ({ callId: "c", name: "bash", args: { command: "ls" }, status: "done", ...extra });
const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`).join("\n");
const ERR = "38;2;255;107;107";

// ------------------------------------------------------------------ Line

test("Line cuts to the width and renders one line", () => {
  assert.deepEqual(new Line("short").render(80), ["short"]);
  const cut = new Line("x".repeat(50)).render(10);
  assert.equal(cut.length, 1);
  assert.ok(visibleWidth(cut[0]) <= 10);
  assert.deepEqual(new Line("").render(10), [""]);
  new Line("x").invalidate();
});

// ------------------------------------------------------------------ user items

test("a user message gets a blank line above, a › prefix, and a hanging indent", () => {
  const out = plain(itemComponent({ kind: "user", id: 1, text: "first\nsecond\n\nfourth" }, false));
  assert.deepEqual(out.map((l) => l.trimEnd()), ["", "› first", "  second", "", "  fourth"]);
});

test("a long user message wraps inside the width and indents the continuation lines", () => {
  const out = plain(itemComponent({ kind: "user", id: 1, text: "word ".repeat(30) }, false), 24);
  assert.ok(out.length > 4);
  assert.ok(out[1].startsWith("› "));
  for (const line of out.slice(2)) assert.ok(line.startsWith("  "), JSON.stringify(line));
  for (const line of itemComponent({ kind: "user", id: 1, text: "word ".repeat(30) }, false).render(24)) assert.ok(visibleWidth(line) <= 24);
});

// ------------------------------------------------------------------ assistant items

const assistant = (blocks: Extract<TranscriptItem, { kind: "assistant" }>["blocks"], extra: Partial<Extract<TranscriptItem, { kind: "assistant" }>> = {}): TranscriptItem => ({
  kind: "assistant",
  id: 1,
  streaming: false,
  blocks,
  ...extra,
});

test("an assistant message starts with a blank line and renders its markdown", () => {
  const out = plain(itemComponent(assistant([{ type: "text", text: "# Heading\n\n- one\n- two\n\nplain **bold** text" }]), false));
  assert.equal(out[0], "");
  const body = out.join("\n");
  assert.match(body, /Heading/);
  assert.ok(!body.includes("# Heading"), "the # marker is not shown");
  assert.match(body, /- one|• one|· one/);
  assert.match(body, /plain bold text/);
});

test("a streaming assistant with nothing yet shows an ellipsis; with content it does not", () => {
  assert.deepEqual(plain(itemComponent({ kind: "assistant", id: "live", streaming: true, blocks: [] }, false)), ["", "…"]);
  const withText = plain(itemComponent({ kind: "assistant", id: "live", streaming: true, blocks: [{ type: "text", text: "partial" }] }, false)).join("\n");
  assert.ok(withText.includes("partial"));
  assert.ok(!withText.includes("…"));
  assert.deepEqual(plain(itemComponent(assistant([]), false)), [""], "a finished empty message is only the blank line");
});

test("an assistant error is shown after the blocks", () => {
  const out = plain(itemComponent(assistant([{ type: "text", text: "partial" }], { error: "Interrupted. Partial response preserved." }), false));
  assert.equal(out.at(-1), "! Interrupted. Partial response preserved.");
  const raw = itemComponent(assistant([], { error: "boom" }), false).render(80).at(-1)!;
  assert.ok(raw.includes(ERR), "errors use the error color");
});

test("thinking is one collapsed line, or wrapped in full when expanded", () => {
  const thought = "first idea\nsecond   idea\n" + "more ".repeat(30);
  const collapsed = plain(itemComponent(assistant([{ type: "thinking", text: thought }]), false), 60);
  assert.equal(collapsed.length, 2, "blank line plus one line");
  assert.match(collapsed[1], /^∴ first idea second idea more more/, "whitespace and newlines collapse");

  const expanded = plain(itemComponent(assistant([{ type: "thinking", text: thought }]), true), 40);
  assert.ok(expanded.length > 4);
  assert.ok(expanded[1].startsWith("∴ first idea"));
  assert.equal(expanded[2], "  second   idea", "continuation lines hang under the text; inner spacing is kept");
  for (const line of itemComponent(assistant([{ type: "thinking", text: thought }]), true).render(40)) assert.ok(visibleWidth(line) <= 40);
});

test("tool blocks inside an assistant message render as tool rows, in order with text", () => {
  const out = plain(
    itemComponent(
      assistant([
        { type: "text", text: "Looking." },
        { type: "tool", call: call({ result: "a\nb" }) },
        { type: "text", text: "Done." },
      ]),
      false,
    ),
  ).join("\n");
  assert.ok(out.indexOf("Looking.") < out.indexOf("✓ bash ls"));
  assert.ok(out.indexOf("✓ bash ls") < out.indexOf("Done."));
});

// ------------------------------------------------------------------ tool rows

test("a tool row shows an icon per status", () => {
  const icon = (status: ToolCallView["status"]) => plain(new ToolRow(call({ status }), false))[0][0];
  spinner.frame = 0;
  assert.equal(icon("done"), "✓");
  assert.equal(icon("error"), "✗");
  assert.equal(icon("pending"), "○");
  assert.equal(icon("running"), "⠋");
});

test("a running tool row follows the spinner frame and wraps around", () => {
  const first = (frame: number) => {
    spinner.frame = frame;
    return plain(new ToolRow(call({ status: "running" }), false))[0][0];
  };
  const frames = Array.from({ length: 10 }, (_, i) => first(i));
  assert.deepEqual(frames, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
  assert.equal(first(13), "⠸");
  assert.equal(first(10), "⠋");
  spinner.frame = 0;
});

test("the argument preview prefers command, then path, file_path, pattern, task, query", () => {
  const head = (args: unknown) => plain(new ToolRow(call({ args }), false))[0];
  assert.equal(head({ query: "q", task: "t", pattern: "p", file_path: "f", path: "pa", command: "c" }), "✓ bash c");
  assert.equal(head({ query: "q", task: "t", pattern: "p", file_path: "f", path: "pa" }), "✓ bash pa");
  assert.equal(head({ query: "q", task: "t", pattern: "p", file_path: "f" }), "✓ bash f");
  assert.equal(head({ query: "q", task: "t", pattern: "p" }), "✓ bash p");
  assert.equal(head({ query: "q", task: "t" }), "✓ bash t");
  assert.equal(head({ query: "q" }), "✓ bash q");
});

test("the argument preview skips non-string values, collapses whitespace, and falls back to JSON", () => {
  const head = (args: unknown) => plain(new ToolRow(call({ args }), false))[0].trimEnd();
  assert.equal(head({ command: 5, path: "/tmp/x" }), "✓ bash /tmp/x");
  assert.equal(head({ command: "a\n  b\t\tc" }), "✓ bash a b c");
  assert.equal(head({ n: 1, flag: true }), '✓ bash {"n":1,"flag":true}');
  assert.equal(head({ command: ["ls"] }), '✓ bash {"command":["ls"]}');
  assert.equal(head({}), "✓ bash");
  assert.equal(head(undefined), "✓ bash");
  assert.equal(head(null), "✓ bash");
  assert.equal(head("raw string"), '✓ bash "raw string"');
  assert.equal(head([1, 2]), "✓ bash [1,2]");
});

test("the head line is cut to the width", () => {
  for (const width of [10, 25, 60]) for (const line of new ToolRow(call({ name: "a_long_tool_name", args: { command: "x".repeat(300) } }), false).render(width)) assert.ok(visibleWidth(line) <= width);
});

test("a tool with no output is just its head line", () => {
  assert.equal(new ToolRow(call(), false).render(80).length, 1);
  assert.equal(new ToolRow(call({ result: "" }), false).render(80).length, 1);
  assert.equal(new ToolRow(call({ result: "  \n\n \t\n" }), false).render(80).length, 1, "whitespace only counts as empty");
  assert.equal(new ToolRow(call({ output: "" }), true).render(80).length, 1);
});

test("a result wins over live output, and live output is shown while running", () => {
  assert.deepEqual(plain(new ToolRow(call({ result: "final", output: "partial" }), false)).slice(1), ["  │ final"]);
  assert.deepEqual(plain(new ToolRow(call({ status: "running", output: "partial" }), false)).slice(1), ["  │ partial"]);
});

test("the output tail is the last 6 lines; the earlier-lines note appears only when something is cut", () => {
  const rows = (n: number) => plain(new ToolRow(call({ result: numbered(n) }), false));
  assert.equal(rows(1).length, 2);
  assert.equal(rows(6).length, 1 + 6, "exactly six lines fit");
  assert.ok(!rows(6).join("\n").includes("earlier"));
  const seven = rows(7);
  assert.equal(seven.length, 1 + 1 + 6);
  assert.equal(seven[1], "  │ … 1 earlier line (ctrl+o)");
  assert.equal(seven[2], "  │ line 2", "the first line is the one cut");
  assert.equal(seven.at(-1), "  │ line 7");
  assert.equal(rows(100)[1], "  │ … 94 earlier lines (ctrl+o)");
  assert.equal(rows(8)[1], "  │ … 2 earlier lines (ctrl+o)");
});

test("expanded output shows every line and no note, with blank lines kept and long lines wrapped", () => {
  const body = `a\n\n${"w".repeat(100)}\nz`;
  const out = plain(new ToolRow(call({ result: body }), true), 30);
  assert.ok(!out.join("\n").includes("earlier"));
  assert.equal(out[1], "  │ a");
  assert.equal(out[2].trimEnd(), "  │", "a blank line keeps its gutter");
  assert.ok(out.length > 6, "the long line wrapped");
  assert.equal(out.at(-1), "  │ z");
  for (const line of new ToolRow(call({ result: body }), true).render(30)) assert.ok(visibleWidth(line) <= 30);
  assert.equal(plain(new ToolRow(call({ result: numbered(20) }), true)).length, 21);
});

test("trailing whitespace in the output is dropped before counting lines", () => {
  const out = plain(new ToolRow(call({ result: "a\nb\n\n\n" }), false));
  assert.deepEqual(out, ["✓ bash ls", "  │ a", "  │ b"]);
});

test("error output is drawn in the error color, other output is not", () => {
  const err = new ToolRow(call({ status: "error", result: "bad" }), false).render(80);
  assert.ok(err[1].includes(ERR));
  const ok = new ToolRow(call({ status: "done", result: "fine" }), false).render(80);
  assert.ok(!ok[1].includes(ERR));
});

test("a ToolRow can be invalidated", () => {
  new ToolRow(call(), false).invalidate();
});

// ------------------------------------------------------------------ tool-result and other items

test("a bare tool result renders as a tool row named after the tool, failed or not", () => {
  const ok = plain(itemComponent({ kind: "tool-result", id: 9, name: "read", text: "contents", isError: false }, false));
  assert.deepEqual(ok.map((l) => l.trimEnd()), ["✓ read", "  │ contents"]);
  const bad = plain(itemComponent({ kind: "tool-result", id: 9, name: "read", text: "ENOENT", isError: true }, false));
  assert.deepEqual(bad.map((l) => l.trimEnd()), ["✗ read", "  │ ENOENT"]);
  assert.ok(itemComponent({ kind: "tool-result", id: 9, name: "read", text: "ENOENT", isError: true }, false).render(80)[1].includes(ERR));
});

test("a standalone tool item renders its call", () => {
  assert.deepEqual(plain(itemComponent({ kind: "tool", id: "d", call: call({ name: "grep", args: { pattern: "todo" }, status: "pending" }) }, false)), ["○ grep todo"]);
});

test("any other item is a muted rule line with its text", () => {
  for (const entryKind of ["pi.reset", "pi.compaction", "something.else"]) {
    const out = plain(itemComponent({ kind: "event", id: 4, entryKind, text: "Context compacted." }, false));
    assert.deepEqual(out, ["── Context compacted. "]);
  }
  for (const line of itemComponent({ kind: "event", id: 4, entryKind: "x", text: "long ".repeat(50) }, false).render(30)) assert.ok(visibleWidth(line) <= 30);
});

// ------------------------------------------------------------------ TranscriptView

const user = (id: number, text: string): TranscriptItem => ({ kind: "user", id, text });
const live = (text: string): TranscriptItem => ({ kind: "assistant", id: "live", streaming: true, blocks: [{ type: "text", text }] });

test("an empty view renders nothing", () => {
  const view = new TranscriptView();
  view.update([]);
  assert.deepEqual(view.render(80), []);
});

test("components are reused only while their item is unchanged", () => {
  const view = new TranscriptView();
  view.update([user(1, "one"), user(2, "two")]);
  const [a, b] = [...view.children];
  view.update([user(1, "one"), user(2, "two changed")]);
  const [a2, b2] = [...view.children];
  assert.equal(a2, a, "unchanged item keeps its component");
  assert.notEqual(b2, b, "changed item gets a new one");
  assert.match(plain(view).join("\n"), /two changed/);
});

test("the same id under different kinds does not collide", () => {
  const view = new TranscriptView();
  view.update([user(1, "question"), { kind: "assistant", id: 1, streaming: false, blocks: [{ type: "text", text: "answer" }] }]);
  const out = plain(view).join("\n");
  assert.ok(out.includes("question") && out.includes("answer"));
  assert.equal(view.children.length, 2);
});

test("a growing assistant message updates its own component in place", () => {
  const view = new TranscriptView();
  view.update([live("hel")]);
  const [component] = [...view.children];
  assert.match(plain(view).join("\n"), /hel/);
  view.update([live("hello world")]);
  assert.equal([...view.children][0], component, "same component, new text");
  assert.match(plain(view).join("\n"), /hello world/);
  view.update([{ kind: "assistant", id: "live", streaming: true, blocks: [{ type: "text", text: "hello world" }, { type: "tool", call: call({ status: "running" }) }] }]);
  assert.equal([...view.children][0], component);
  assert.match(plain(view).join("\n"), /bash ls/);
});

test("when the live message becomes a committed entry it is a different item", () => {
  const view = new TranscriptView();
  view.update([live("done")]);
  const [liveComponent] = [...view.children];
  view.update([{ kind: "assistant", id: 5, streaming: false, blocks: [{ type: "text", text: "done" }] }]);
  assert.notEqual([...view.children][0], liveComponent);
  assert.equal(view.children.length, 1);
});

test("items that disappear are dropped, and come back as fresh components", () => {
  const view = new TranscriptView();
  view.update([user(1, "one"), user(2, "two")]);
  const second = [...view.children][1];
  view.update([user(1, "one")]);
  assert.equal(view.children.length, 1);
  view.update([user(1, "one"), user(2, "two")]);
  assert.notEqual([...view.children][1], second);
});

test("toggling expand rebuilds rows and re-renders assistant messages in place", () => {
  const long = numbered(20);
  const items: TranscriptItem[] = [
    { kind: "tool-result", id: 3, name: "read", text: long, isError: false },
    { kind: "assistant", id: 4, streaming: false, blocks: [{ type: "thinking", text: "a\nb" }, { type: "tool", call: call({ result: long }) }] },
  ];
  const view = new TranscriptView();
  view.update(items);
  const [row, message] = [...view.children];
  const collapsed = view.render(80);
  assert.ok(plain(view).join("\n").includes("earlier lines"));

  view.expand = true;
  view.update(items);
  const [row2, message2] = [...view.children];
  assert.notEqual(row2, row, "the signature includes the expand flag");
  assert.equal(message2, message, "an assistant message keeps its component");
  const expanded = view.render(80);
  assert.ok(expanded.length > collapsed.length);
  assert.ok(!plain(view).join("\n").includes("earlier lines"));
  assert.match(plain(view).join("\n"), /∴ a/);

  view.expand = false;
  view.update(items);
  assert.deepEqual(view.render(80), collapsed, "back to the collapsed rendering");
});

test("reset forgets every component", () => {
  const view = new TranscriptView();
  view.update([user(1, "one")]);
  const [first] = [...view.children];
  view.reset();
  assert.deepEqual(view.render(80), []);
  view.update([user(1, "one")]);
  assert.notEqual([...view.children][0], first);
});

test("a view renders every item kind within the width", () => {
  const view = new TranscriptView();
  const items: TranscriptItem[] = [
    user(1, "漢字 ".repeat(40)),
    { kind: "assistant", id: 2, streaming: false, blocks: [{ type: "thinking", text: "hmm ".repeat(50) }, { type: "text", text: "text ".repeat(60) }, { type: "tool", call: call({ result: numbered(9) }) }], error: "e".repeat(200) },
    { kind: "tool-result", id: 3, name: "read", text: "r".repeat(300), isError: true },
    { kind: "tool", id: "t", call: call({ status: "running", output: "o".repeat(300) }) },
    { kind: "event", id: 4, entryKind: "pi.reset", text: "New context started. ".repeat(10) },
  ];
  view.update(items);
  for (const width of [12, 40, 120]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
});
