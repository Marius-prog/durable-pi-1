import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantError,
  lastAssistantText,
  messageText,
  sumUsage,
  toMarkdown,
  toTranscript,
  type LiveTool,
  type TranscriptItem,
} from "../src/transcript.js";
import type { WireAssistantMessage, WireEntry, WireToolResultMessage, WireUsage } from "../src/api.js";

const usage = (over: Partial<WireUsage> = {}): WireUsage => ({
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
  ...over,
});
const assistant = (content: WireAssistantMessage["content"], extra: Partial<WireAssistantMessage> = {}): WireAssistantMessage => ({
  role: "assistant",
  content,
  provider: "p",
  model: "m1",
  usage: usage(),
  stopReason: "stop",
  ...extra,
});
const toolResult = (id: string, text: string, isError = false, name = "bash"): WireToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});
const entry = (id: number, kind: string, model?: WireEntry["model"], data?: unknown): WireEntry => ({
  id,
  conversationId: 1,
  kind,
  ...(model ? { model } : {}),
  ...(data !== undefined ? { data } : {}),
});

// ------------------------------------------------------------------ messageText / assistantError

test("messageText reads strings, joins text blocks, skips images and tolerates missing content", () => {
  assert.equal(messageText({ role: "user", content: "plain" }), "plain");
  assert.equal(
    messageText({
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" } as never,
        { type: "text", text: "b" },
      ],
    }),
    "ab",
  );
  assert.equal(messageText({ role: "other" }), "");
  assert.equal(messageText({ role: "user", content: [{ type: "text" } as never] }), "");
});

test("assistantError prefers the provider message, then names aborted and failed runs", () => {
  assert.equal(assistantError(assistant([], { errorMessage: "429 slow down", stopReason: "error" })), "429 slow down");
  assert.equal(assistantError(assistant([], { stopReason: "aborted" })), "Interrupted. Partial response preserved.");
  assert.equal(assistantError(assistant([], { stopReason: "error" })), "Provider request failed.");
  assert.equal(assistantError(assistant([], { stopReason: "stop" })), undefined);
  assert.equal(assistantError(assistant([], { stopReason: "toolUse" })), undefined);
});

// ------------------------------------------------------------------ toTranscript

test("a user entry joins its messages with newlines; pi.system entries are hidden", () => {
  const items = toTranscript([
    entry(1, "pi.system", [{ role: "system" } as never]),
    entry(2, "pi.user", [
      { role: "user", content: "one" },
      { role: "user", content: [{ type: "text", text: "two" }] },
    ]),
    entry(3, "pi.user"),
  ]);
  assert.deepEqual(items, [
    { kind: "user", id: 2, text: "one\ntwo" },
    { kind: "user", id: 3, text: "" },
  ]);
});

test("assistant blocks: empty text and thinking are dropped, thinking and text are kept in order", () => {
  const [item] = toTranscript([
    entry(1, "pi.assistant", [
      assistant([
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "" },
        { type: "text", text: "answer" },
      ]),
    ]),
  ]);
  assert.equal(item.kind, "assistant");
  if (item.kind !== "assistant") return;
  assert.deepEqual(item.blocks, [
    { type: "thinking", text: "hmm" },
    { type: "text", text: "answer" },
  ]);
  assert.equal(item.streaming, false);
  assert.equal(item.model, "m1");
  assert.equal(item.error, undefined);
});

test("an assistant entry with several messages merges their blocks and reports the first error", () => {
  const [item] = toTranscript([
    entry(1, "pi.assistant", [
      assistant([{ type: "text", text: "a" }]),
      assistant([{ type: "text", text: "b" }], { stopReason: "error" }),
      assistant([{ type: "text", text: "c" }], { errorMessage: "late" }),
    ]),
  ]);
  assert.ok(item.kind === "assistant");
  assert.equal(item.kind === "assistant" && item.blocks.length, 3);
  assert.equal(item.kind === "assistant" && item.error, "Provider request failed.");
});

test("a tool call picks up its result: status, text and result entry id; errors map to error", () => {
  const items = toTranscript([
    entry(1, "pi.assistant", [
      assistant([
        { type: "toolCall", id: "ok", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "bad", name: "bash", arguments: { command: "false" } },
        { type: "toolCall", id: "open", name: "bash", arguments: {} },
      ]),
    ]),
    entry(2, "pi.tool-result", [toolResult("ok", "contents", false, "read")]),
    entry(3, "pi.tool-result", [toolResult("bad", "exit 1", true)]),
  ]);
  // Results that belong to a call are folded into it, not listed again.
  assert.deepEqual(items.map((i) => i.kind), ["assistant"]);
  const blocks = items[0].kind === "assistant" ? items[0].blocks : [];
  const calls = blocks.map((b) => (b.type === "tool" ? b.call : undefined));
  assert.deepEqual(calls[0], {
    callId: "ok",
    name: "read",
    args: { path: "a" },
    status: "done",
    result: "contents",
    resultEntryId: 2,
  });
  assert.equal(calls[1]?.status, "error");
  assert.equal(calls[1]?.result, "exit 1");
  assert.deepEqual(calls[2], { callId: "open", name: "bash", args: {}, status: "pending", output: undefined });
});

test("live tool output shows on a call that has no result yet: running vs pending", () => {
  const tools = new Map<string, LiveTool>([
    ["a", { name: "bash", status: "running", output: "line 1\n" }],
    ["b", { name: "bash", status: "pending", output: "" }],
    ["c", { name: "bash", status: "running", output: "" }],
  ]);
  const items = toTranscript(
    [
      entry(1, "pi.assistant", [
        assistant([
          { type: "toolCall", id: "a", name: "bash", arguments: {} },
          { type: "toolCall", id: "b", name: "bash", arguments: {} },
          { type: "toolCall", id: "c", name: "bash", arguments: {} },
        ]),
      ]),
    ],
    undefined,
    tools,
  );
  const calls = items[0].kind === "assistant" ? items[0].blocks.flatMap((b) => (b.type === "tool" ? [b.call] : [])) : [];
  assert.deepEqual(
    calls.map((c) => [c.status, c.output]),
    [
      ["running", "line 1\n"],
      ["pending", undefined],
      ["running", undefined],
    ],
  );
});

test("a tool result whose call is not in the transcript is listed on its own", () => {
  const items = toTranscript([
    entry(5, "pi.tool-result", [toolResult("gone", "orphan text", true, "read"), toolResult("gone2", "second")]),
  ]);
  assert.deepEqual(items, [
    { kind: "tool-result", id: 5, name: "read", text: "orphan text", isError: true },
    { kind: "tool-result", id: 5, name: "bash", text: "second", isError: false },
  ]);
});

test("the live message is appended as a streaming item and its tool calls claim their results", () => {
  const live = assistant([{ type: "text", text: "typing" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], { model: "live-model" });
  const items = toTranscript([entry(4, "pi.tool-result", [toolResult("t1", "done")])], live);
  assert.deepEqual(items.map((i) => i.kind), ["assistant"], "the result is folded into the live call");
  const item = items[0];
  assert.ok(item.kind === "assistant");
  if (item.kind !== "assistant") return;
  assert.equal(item.id, "live");
  assert.equal(item.streaming, true);
  assert.equal(item.model, "live-model");
  assert.equal(item.blocks[1].type === "tool" && item.blocks[1].call.status, "done");
});

test("running tools with no transcript call become standalone tool items; finished ones are skipped", () => {
  const tools = new Map<string, LiveTool>([
    ["x", { name: "grep", status: "running", output: "hit", args: { q: 1 } }],
    ["y", { name: "grep", status: "done", output: "" }],
    ["z", { name: "ls", status: "pending", output: "" }],
  ]);
  const items = toTranscript([], undefined, tools);
  assert.deepEqual(items, [
    { kind: "tool", id: "x", call: { callId: "x", name: "grep", args: { q: 1 }, status: "running", output: "hit" } },
    { kind: "tool", id: "z", call: { callId: "z", name: "ls", args: undefined, status: "pending", output: undefined } },
  ]);
});

test("other entry kinds become event items with fitting text, notes and data", () => {
  const items = toTranscript([
    entry(1, "pi.reset"),
    entry(2, "pi.compaction", [{ role: "user", content: "summary text" }]),
    entry(3, "demo.event", undefined, { text: "from data" }),
    entry(4, "demo.other", undefined, { count: 3 }),
    entry(5, "pi.reset", undefined, { text: 42 }),
  ]);
  assert.deepEqual(items, [
    { kind: "event", id: 1, entryKind: "pi.reset", text: "New context started. Earlier entries remain stored.", note: undefined },
    { kind: "event", id: 2, entryKind: "pi.compaction", text: "Context compacted. Earlier entries remain stored.", note: "summary text" },
    { kind: "event", id: 3, entryKind: "demo.event", text: "from data", note: undefined, data: { text: "from data" } },
    { kind: "event", id: 4, entryKind: "demo.other", text: "demo.other", note: undefined, data: { count: 3 } },
    { kind: "event", id: 5, entryKind: "pi.reset", text: "New context started. Earlier entries remain stored.", note: undefined, data: { text: 42 } },
  ]);
});

// ------------------------------------------------------------------ toMarkdown

test("toMarkdown renders every item kind", () => {
  const items: TranscriptItem[] = [
    { kind: "user", id: 1, text: "hi" },
    {
      kind: "assistant",
      id: 2,
      streaming: false,
      blocks: [
        { type: "thinking", text: "line one\nline two" },
        { type: "text", text: "hello" },
        { type: "tool", call: { callId: "c", name: "bash", args: {}, status: "done", result: "out" } },
        { type: "tool", call: { callId: "d", name: "ls", args: {}, status: "pending" } },
      ],
      error: "Provider request failed.",
    },
    { kind: "assistant", id: "live", streaming: true, blocks: [{ type: "text", text: "so far" }] },
    { kind: "tool-result", id: 3, name: "read", text: "boom", isError: true },
    { kind: "tool-result", id: 4, name: "read", text: "fine", isError: false },
    { kind: "tool", id: "t", call: { callId: "t", name: "grep", args: {}, status: "running" } },
    { kind: "event", id: 5, entryKind: "pi.reset", text: "New context started." },
  ];
  assert.equal(
    toMarkdown(items),
    [
      "### You (#1)\n\nhi",
      "### Agent (#2)\n\n> _thinking:_ line one line two\n\nhello\n\n- `bash` done\n\n```\nout\n```\n\n- `ls` pending\n\n> Provider request failed.",
      "### Agent (working)\n\nso far",
      "- `read` error\n\n```\nboom\n```",
      "- `read` result\n\n```\nfine\n```",
      "- `grep` running",
      "_New context started._",
    ].join("\n\n") + "\n",
  );
});

test("toMarkdown truncates thinking to 400 chars and tool output to 2000", () => {
  const md = toMarkdown([
    {
      kind: "assistant",
      id: 1,
      streaming: false,
      blocks: [
        { type: "thinking", text: "t".repeat(500) },
        { type: "tool", call: { callId: "c", name: "bash", args: {}, status: "done", result: "r".repeat(2500) } },
      ],
    },
    { kind: "tool-result", id: 2, name: "bash", text: "x".repeat(2500), isError: false },
  ]);
  assert.ok(md.includes("t".repeat(400)) && !md.includes("t".repeat(401)));
  assert.ok(md.includes("r".repeat(2000)) && !md.includes("r".repeat(2001)));
  assert.ok(md.includes("x".repeat(2000)) && !md.includes("x".repeat(2001)));
});

test("toMarkdown of nothing is a single newline", () => {
  assert.equal(toMarkdown([]), "\n");
});

// ------------------------------------------------------------------ lastAssistantText

test("lastAssistantText returns the newest non-empty assistant text, trimmed", () => {
  const entries: WireEntry[] = [
    entry(1, "pi.assistant", [assistant([{ type: "text", text: "old" }])]),
    entry(2, "pi.user", [{ role: "user", content: "q" }]),
    entry(3, "pi.assistant", [assistant([{ type: "text", text: "  newest answer \n" }])]),
    entry(4, "pi.assistant", [assistant([{ type: "toolCall", id: "t", name: "bash", arguments: {} }])]),
    entry(5, "pi.assistant"),
  ];
  assert.equal(lastAssistantText(entries), "newest answer");
  assert.equal(lastAssistantText(entries.slice(0, 2)), "old");
  assert.equal(lastAssistantText([entries[1]]), undefined);
  assert.equal(lastAssistantText([]), undefined);
});

// ------------------------------------------------------------------ sumUsage

test("sumUsage adds every model, and an empty or missing state is all zeros", () => {
  const zero = {
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
  assert.deepEqual(sumUsage(), zero);
  assert.deepEqual(sumUsage({ models: {} }), zero);
  const total = sumUsage({ models: { a: usage(), b: usage({ input: 100, output: 50, totalTokens: 153 }) } });
  assert.equal(total.tokens, 18 + 153);
  assert.equal(total.input, 110);
  assert.equal(total.output, 55);
  assert.equal(total.cacheRead, 4);
  assert.equal(total.cacheWrite, 2);
  assert.ok(Math.abs(total.cost - 0.0066) < 1e-12);
  assert.ok(Math.abs(total.inputCost - 0.002) < 1e-12);
  assert.ok(Math.abs(total.outputCost - 0.004) < 1e-12);
  assert.ok(Math.abs(total.cacheReadCost - 0.0002) < 1e-12);
  assert.ok(Math.abs(total.cacheWriteCost - 0.0004) < 1e-12);
});

test("sumUsage falls back to adding the parts when totalTokens is missing, and ignores a missing cost", () => {
  const partial = { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 } as unknown as WireUsage;
  const total = sumUsage({ models: { a: partial } });
  assert.equal(total.tokens, 18);
  assert.equal(total.cost, 0);
  assert.equal(total.inputCost, 0);
});
