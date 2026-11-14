import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolCall } from "@earendil-works/pi-ai";
import { insertLog, makeRow, openLogDb, tempDir } from "./helpers.ts";
import { Deploys, Incidents, createExtensions, logLine } from "../apps/proactive-dpi-be/src/extensions.ts";
import { WatchStore } from "../apps/proactive-dpi-be/src/watch-store.ts";
import type { Incident, StreamRow, Verdict } from "../shared/types.ts";

// ── logLine ─────────────────────────────────────────────────────────────────────────────────────────

const streamRow = (over: Parameters<typeof makeRow>[0] = {}, verdict?: Verdict): StreamRow => ({ ...makeRow(over), verdict });

test("logLine: id, timestamp, severity, service@revision, request, message and the Jev verdict", () => {
  const row = streamRow(
    { id: 12, ts: "2026-10-05T10:00:00.000Z", severity: "INFO", message: "checkout completed order=ord_1", status: 200, latencyMs: 180 },
    { logId: 12, status: "judged", fingerprint: "fp", decision: "normal", probability: 0.987, judgedAt: 1 },
  );
  assert.equal(
    logLine(row),
    "#12 2026-10-05T10:00:00.000Z INFO checkout-api@checkout-api-00041-rup POST /v1/checkout 200 180ms checkout completed order=ord_1 jev=normal 0.99",
  );
});

test("logLine: errors carry their error type in brackets", () => {
  const row = streamRow(
    { id: 3, ts: "t", severity: "ERROR", status: 500, latencyMs: 9, message: "Unhandled exception", errorType: "TypeError" },
    { logId: 3, status: "judged", fingerprint: "fp", decision: "incident", probability: 0.9, judgedAt: 1 },
  );
  assert.equal(logLine(row), "#3 t ERROR checkout-api@checkout-api-00041-rup POST /v1/checkout 500 9ms Unhandled exception [TypeError] jev=incident 0.90");
});

test("logLine: rows without an HTTP request skip the request part", () => {
  const row = streamRow({ id: 4, ts: "t", method: null, route: null, status: null, latencyMs: null, severity: "NOTICE", message: "Revision r is ready." });
  assert.equal(logLine(row), "#4 t NOTICE checkout-api@checkout-api-00041-rup Revision r is ready. jev=pending");
});

test("logLine: rows Jev has not judged read as pending, and failed or skipped ones show their status", () => {
  assert.ok(logLine(streamRow()).endsWith(" jev=pending"));
  const verdict = (status: Verdict["status"]): Verdict => ({ logId: 1, status, fingerprint: "fp", judgedAt: 1 });
  assert.ok(logLine(streamRow({}, verdict("error"))).endsWith(" jev=error"));
  assert.ok(logLine(streamRow({}, verdict("skipped"))).endsWith(" jev=skipped"));
});

// ── documents ───────────────────────────────────────────────────────────────────────────────────────

test("the incident and deploy documents are session scoped and start empty", () => {
  for (const [doc, kind] of [[Incidents, "ops.incidents"], [Deploys, "ops.deploys"]] as const) {
    assert.equal(doc.definition.kind, kind);
    assert.equal(doc.definition.version, 1);
    assert.equal(doc.definition.scope, "session");
  }
  assert.deepEqual(Incidents.definition.initial(), { seq: 0, items: {} });
  assert.deepEqual(Deploys.definition.initial(), { items: {} });
  assert.notEqual(Incidents.definition.initial(), Incidents.definition.initial(), "each call returns a fresh object");
});

// ── the extension bundles ───────────────────────────────────────────────────────────────────────────

let t: ReturnType<typeof tempDir>;
let logs: DatabaseSync;
let store: WatchStore;

beforeEach(() => {
  t = tempDir();
  logs = openLogDb(t.root);
  store = new WatchStore(join(t.root, "watch.sqlite"), join(t.root, "logs.sqlite"));
});
afterEach(() => {
  store.close();
  logs.close();
  t.cleanup();
});

const noop = () => {};
const extensions = () => createExtensions({ store, incidentChanged: noop });

test("the Ops desk can read logs and incidents, and nothing else", () => {
  const { OpsTools, Desk, IncidentAgent } = extensions();
  assert.deepEqual(OpsTools.tools!.map((x) => x.name), ["query_logs", "log_summary", "list_incidents"]);
  assert.deepEqual(IncidentAgent.tools!.map((x) => x.name), ["update_incident", "submit_fix", "deploy"]);
  assert.equal(Desk.tools, undefined);
  assert.deepEqual(IncidentAgent.tasks!.map((x) => (x as unknown as { definition: { name: string } }).definition.name), ["ops.deploy"]);
});

test("every tool is replay safe, so a restart reruns it instead of reporting an interruption", () => {
  const { OpsTools, IncidentAgent } = extensions();
  for (const tool of [...OpsTools.tools!, ...IncidentAgent.tools!]) assert.equal(tool.replay, "safe", tool.name);
});

test("the playbook names every tool the incident agent has and the five stages in order", () => {
  const { IncidentAgent } = extensions();
  const text = String(IncidentAgent.sections![0].render({} as never, {} as never));
  for (const name of ["update_incident", "submit_fix", "deploy", "log_summary", "query_logs"]) assert.ok(text.includes(name), name);
  const positions = ["Investigate", "Locate", "Fix", "Review", "Deploy"].map((s) => text.indexOf(`. ${s}.`));
  assert.ok(positions.every((p) => p > 0), positions.join());
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(text, /never push, merge, rebase, switch branches, or touch main/);
});

test("the Ops desk prompt says it does not change code", () => {
  const text = String(extensions().Desk.sections![0].render({} as never, {} as never));
  assert.match(text, /You do not change code\./);
});

// ── the git guard ───────────────────────────────────────────────────────────────────────────────────

type BeforeTool = (call: ToolCall, api: unknown, context: unknown) => { block?: string } | undefined;

function guard(): BeforeTool {
  const registration = extensions().IncidentAgent.hooks!.find((h) => h.task === "pi.tool")!;
  assert.ok(registration, "the incident agent hooks the built-in tool task");
  return (registration.handlers as { beforeTool: BeforeTool }).beforeTool;
}
const bash = (command: unknown): ToolCall => ({ type: "toolCall", id: "c1", name: "bash", arguments: { command } as never });
const verdictOn = (command: unknown) => guard()(bash(command), {}, {});

const BLOCKED = [
  "git push",
  "git push origin incident/inc-0001",
  "git push --force origin HEAD:main",
  "git merge main",
  "git merge --no-ff incident/inc-0002",
  "git rebase main",
  "git rebase -i HEAD~3",
  "git switch main",
  "git switch -c other",
  "git worktree add ../x",
  "git worktree remove ../x",
  "git worktree prune",
  "git reset --hard",
  "git reset --hard HEAD~1",
  "git reset --hard origin/main",
  "git branch -d incident/inc-0002",
  "git branch -D incident/inc-0002",
  "git branch -m renamed",
  "git branch -M renamed",
  "git checkout -b other",
  "git checkout -B other",
  "git checkout main",
  "git checkout master",
  // The guard sees the whole command line, so chaining does not hide a blocked command.
  "cd .. && git push",
  "npm test; git push origin HEAD",
  "git status || git merge main",
  "echo done | git rebase main",
  "(git push)",
  'bash -c "git push"',
  "git  push",
  "git\tpush",
  "GIT_TERMINAL_PROMPT=0 git push",
  "  git push",
  "git status\ngit push",
];

const ALLOWED = [
  "git status",
  "git log --oneline -5",
  "git show 1a2b3c4",
  "git show HEAD --stat",
  "git diff main...HEAD",
  "git diff --stat",
  "git add -A",
  'git commit -m "fix(pricing): guests"',
  "git commit --amend --no-edit",
  "git checkout -- src/pricing/loyalty.ts",
  "git checkout src/pricing/loyalty.ts",
  "git branch",
  "git branch --show-current",
  "git branch -v",
  "git reset HEAD src/x.ts",
  "git reset --soft HEAD~1",
  "git reset --mixed HEAD~1",
  "git stash",
  "git rev-parse --short HEAD",
  "git blame src/pricing/cart.ts",
  "node --test test/guest.test.ts",
  "npm test",
  "ls -la",
  "cat src/pricing/loyalty.ts",
  "grep -rn pushState src",
  "echo 'please do not git-push'",
  "gitpush",
  "digit push",
];

for (const command of BLOCKED)
  test(`git guard blocks: ${JSON.stringify(command)}`, () => {
    const result = verdictOn(command);
    assert.ok(result?.block, "blocked");
    assert.match(result.block, /^Blocked by the incident guard\. Stay on your incident branch/);
    assert.match(result.block, /A human reviews and merges\.$/);
  });

for (const command of ALLOWED)
  test(`git guard allows: ${JSON.stringify(command)}`, () => {
    assert.equal(verdictOn(command), undefined);
  });

test("git guard only looks at bash: other tools are never blocked, whatever they contain", () => {
  for (const name of ["read", "write", "edit", "update_incident", "deploy"]) {
    const call: ToolCall = { type: "toolCall", id: "c", name, arguments: { command: "git push", content: "git push" } as never };
    assert.equal(guard()(call, {}, {}), undefined, name);
  }
});

test("git guard tolerates a bash call with no command or a command that is not a string", () => {
  assert.equal(verdictOn(undefined), undefined);
  assert.equal(verdictOn(null), undefined);
  assert.equal(verdictOn(42), undefined);
  assert.equal(verdictOn(""), undefined);
  assert.equal(guard()({ type: "toolCall", id: "c", name: "bash", arguments: {} as never }, {}, {}), undefined);
  assert.ok(verdictOn(["git push"]), "a one-element array is stringified, and caught");
});

// The README says the guard blocks "branch switching, deleting or renaming branches, and worktree changes". The
// pattern in extensions.ts (BLOCKED_GIT) is narrower than that: each command below gets through it today (checked
// by hand against the guard). They are listed as todo tests so they are visible without failing the suite; turn each
// into a normal `test` once the guard blocks it. The incident agent also has `write`, so a determined agent can do
// harm other ways; the guard is a seatbelt for a well-meaning model, not a sandbox.
const GAPS: [string, string][] = [
  ["git -C .. push", "options between git and the subcommand"],
  ["git -c user.name=x push", "a -c override before the subcommand"],
  ["git --no-pager push", "a global flag before the subcommand"],
  ["git branch --delete incident/inc-0002", "the long form of branch -d"],
  ["git branch --move renamed", "the long form of branch -m"],
  ["git branch -f main HEAD", "moving main with branch -f"],
  ["git checkout incident/inc-0002", "switching to another branch with checkout"],
  ["git checkout -", "switching back to the previous branch"],
  ["git update-ref refs/heads/main HEAD", "moving main with plumbing"],
];
for (const [command, why] of GAPS) test.todo(`git guard blocks ${JSON.stringify(command)} (${why})`);

// Pin down that the gaps are real, so the todo list above cannot go stale unnoticed: when one of these starts
// being blocked, this test fails and says which todo to promote.
test("git guard gaps: the todo list above is still accurate", () => {
  const nowBlocked = GAPS.filter(([command]) => verdictOn(command)?.block).map(([command]) => command);
  assert.deepEqual(nowBlocked, [], "these are blocked now: move them from GAPS into BLOCKED");
});

// ── query_logs, log_summary, list_incidents ─────────────────────────────────────────────────────────

const tool = <N extends string>(name: N) => {
  const { OpsTools, IncidentAgent } = extensions();
  return [...OpsTools.tools!, ...IncidentAgent.tools!].find((x) => x.name === name)!;
};
const textOf = (result: { content?: readonly { type: string; text?: string }[] }) => (result.content ?? []).map((c) => c.text ?? "").join("");

function seed() {
  const ok = makeRow({ id: 0, message: "checkout completed", status: 200, ts: new Date(Date.now() - 2000).toISOString() });
  const bad = makeRow({
    id: 0,
    message: "Unhandled exception in checkout handler",
    status: 500,
    severity: "ERROR",
    errorType: "TypeError",
    latencyMs: 12,
    ts: new Date().toISOString(),
    entry: { jsonPayload: { message: "x", stack_trace: "TypeError: Cannot read properties of undefined (reading 'tier')" } },
  });
  const okId = insertLog(logs, ok);
  const badId = insertLog(logs, bad);
  store.saveVerdict({ logId: badId, status: "judged", fingerprint: "fp", decision: "incident", probability: 0.9, judgedAt: 1 }, bad.ts);
  return { okId, badId, ok, bad };
}

test("query_logs: newest first, one line per row with its Jev verdict", async () => {
  const { okId, badId } = seed();
  const out = textOf(await tool("query_logs").execute({}, {} as never, {} as never));
  const [head, first, second] = out.split("\n");
  assert.equal(head, "2 rows, newest first");
  assert.ok(first.startsWith(`#${badId} `) && first.includes("[TypeError]") && first.endsWith("jev=incident 0.90"), first);
  assert.ok(second.startsWith(`#${okId} `) && second.endsWith("jev=pending"), second);
});

test("query_logs: filters map onto the store (status, severity, text, jev, limit)", async () => {
  const { badId } = seed();
  const run = async (args: Record<string, unknown>) => textOf(await tool("query_logs").execute(args as never, {} as never, {} as never));
  assert.ok((await run({ status: 500 })).startsWith("1 rows"));
  assert.ok((await run({ min_severity: "ERROR" })).includes(`#${badId}`));
  assert.ok((await run({ text: "tier" })).startsWith("1 rows"), "searches the raw entry, stack trace included");
  assert.ok((await run({ jev: "incident" })).startsWith("1 rows"));
  assert.ok((await run({ jev: "normal" })).startsWith("0 rows"));
  assert.ok((await run({ limit: 1 })).startsWith("1 rows"));
  assert.ok((await run({ service: "payments-webhook" })).startsWith("0 rows"));
});

test("query_logs: no match says so", async () => {
  const out = textOf(await tool("query_logs").execute({ status: 418 } as never, {} as never, {} as never));
  assert.equal(out, "0 rows, newest first\nNo matching rows.");
});

test("query_logs: full=true appends the complete JSON entry under each line", async () => {
  const { bad } = seed();
  const out = textOf(await tool("query_logs").execute({ status: 500, full: true } as never, {} as never, {} as never));
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[2]), bad.entry);
  assert.ok(lines[2].includes("reading 'tier'"), "the stack trace is there");
});

test("query_logs: since_minutes narrows the window", async () => {
  insertLog(logs, makeRow({ id: 0, ts: new Date(Date.now() - 20 * 60_000).toISOString(), message: "twenty minutes ago" }));
  const run = async (since: number) => textOf(await tool("query_logs").execute({ since_minutes: since } as never, {} as never, {} as never));
  assert.ok((await run(10)).startsWith("0 rows"));
  assert.ok((await run(30)).startsWith("1 rows"));
});

test("log_summary: the store's aggregates as JSON, over the last 15 minutes unless told otherwise", async () => {
  seed();
  const parsed = JSON.parse(textOf(await tool("log_summary").execute({}, {} as never, {} as never)));
  assert.deepEqual(Object.keys(parsed).sort(), ["deploys", "fingerprints", "minutes", "revisions", "since"]);
  assert.equal(parsed.revisions[0].rows, 2);
  assert.equal(parsed.revisions[0].http5xx, 1);
  assert.deepEqual(parsed.fingerprints.map((f: { fingerprint: string; count: number }) => [f.fingerprint, f.count]), [["fp", 1]]);
  const windowMinutes = (Date.now() - Date.parse(parsed.since)) / 60_000;
  assert.ok(windowMinutes > 14.9 && windowMinutes < 15.1, `${windowMinutes}`);
  const wide = JSON.parse(textOf(await tool("log_summary").execute({ since_minutes: 60 } as never, {} as never, {} as never)));
  assert.ok((Date.now() - Date.parse(wide.since)) / 60_000 > 59);
  const none = JSON.parse(textOf(await tool("log_summary").execute({ service: "auth-api" } as never, {} as never, {} as never)));
  assert.deepEqual(none.revisions, []);
});

test("list_incidents: says so when there are none, otherwise lists each without its timeline", async () => {
  const empty = { snapshot: async () => undefined };
  assert.equal(textOf(await tool("list_incidents").execute({}, empty as never, {} as never)), "No incidents.");
  assert.equal(textOf(await tool("list_incidents").execute({}, { snapshot: async () => ({ items: {} }) } as never, {} as never)), "No incidents.");

  const incident = { id: "INC-0001", status: "investigating", timeline: [{ at: 1, status: "starting", summary: "x" }], branch: "incident/inc-0001" } as unknown as Incident;
  const api = { snapshot: async () => ({ items: { "INC-0001": incident } }) };
  const listed = JSON.parse(textOf(await tool("list_incidents").execute({}, api as never, {} as never)));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "INC-0001");
  assert.equal(listed[0].branch, "incident/inc-0001");
  assert.equal("timeline" in listed[0], false);
});
