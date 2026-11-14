// Durable jobs end to end through the Store (faux provider, real shell commands in a temp folder): the paths the
// happy-path test in store.test.ts does not take: a declined approval, a cancelled approval, a failing phase, an
// abort, and the agent's list, run, wait and check tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Store } from "../src/store.js";
import { JOB_RUNS_DOC, type JobRun, type JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { faux, tempStore, until } from "./helpers.js";

const runs = async (store: Store, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return ((await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc).items;
};
const start = async (store: Store, session: string, job: string, input: Record<string, unknown> = {}) => {
  const m = await store.resolveAgent(session, "main");
  return (await store.startJob(m.row, m.h, m.c, { job, input })).taskId;
};
const run = async (store: Store, session: string, id: number): Promise<JobRun> => (await runs(store, session))[id];
const sharedValue = async (store: Store) => (await store.deviceDoc("app.shared-state")).value as Record<string, any>;

test("a declined approval ends the run as declined, skips what follows and publishes nothing", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Decline", cwd: t.work, model: faux });
    const id = await start(store, session.id, "release-check");
    await until(async () => (await run(store, session.id, id)).approval === "pending", 30000, "approval pending");
    const waiting = await run(store, session.id, id);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.phase, "approve");
    assert.deepEqual(waiting.phases.map((p) => p.status), ["done", "done", "waiting", "pending", "pending"]);
    assert.ok(waiting.phases[2].steps.some((s) => s.kind === "approval" && s.status === "waiting"));

    const { c } = await store.resolveAgent(session.id, "main");
    await store.approveJob(c, id, false);
    await until(async () => (await run(store, session.id, id)).status === "declined", 20000, "declined");
    const declined = await run(store, session.id, id);
    assert.equal(declined.approval, "declined");
    assert.equal(declined.error, "Declined by you");
    assert.ok(declined.endedAt);
    assert.deepEqual(declined.phases.map((p) => p.status), ["done", "done", "failed", "skipped", "skipped"]);
    assert.equal(declined.phases[2].summary, "Declined by you");
    assert.ok(declined.phases[2].steps.some((s) => s.kind === "approval" && s.status === "error" && s.label === "Declined by you"));
    assert.equal((await sharedValue(store)).jobs?.["release-check"], undefined, "nothing was published");
    await assert.rejects(() => store.approveJob(c, id, true), /No pending approval/, "the decision is final");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("aborting a run that waits for approval cancels the approval and stops the run", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Cancel", cwd: t.work, model: faux });
    const id = await start(store, session.id, "release-check");
    await until(async () => (await run(store, session.id, id)).approval === "pending", 30000, "approval pending");
    const { c } = await store.resolveAgent(session.id, "main");
    await store.abort(c, true);
    await until(async () => (await run(store, session.id, id)).status === "aborted", 20000, "aborted");
    const aborted = await run(store, session.id, id);
    assert.equal(aborted.approval, "cancelled");
    assert.equal(aborted.error, "Stopped");
    assert.deepEqual(aborted.phases.map((p) => p.status), ["done", "done", "aborted", "skipped", "skipped"]);
    await assert.rejects(() => store.approveJob(c, id, true), /No pending approval/);
    assert.equal((await sharedValue(store)).jobs?.["release-check"], undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a failing command fails the phase, skips the rest and records the error", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Fail", cwd: t.work, model: faux });
    // The folder does not exist, so `cd` fails inside the first phase.
    const id = await start(store, session.id, "workspace-snapshot", { path: "no-such-folder" });
    await until(async () => (await run(store, session.id, id)).status === "failed", 20000, "failed");
    const failed = await run(store, session.id, id);
    assert.match(failed.error ?? "", /Exit \d+/);
    assert.ok(failed.endedAt);
    assert.deepEqual(failed.phases.map((p) => p.status), ["failed", "skipped", "skipped", "skipped"]);
    assert.equal(failed.phases[0].summary, failed.error);
    const bad = failed.phases[0].steps.find((s) => s.status === "error");
    assert.ok(bad && bad.kind === "command" && bad.label.includes("no-such-folder"));
    assert.equal((await sharedValue(store)).jobs?.["workspace-snapshot"], undefined, "a failed run saves no result");
    // The run left the task graph: nothing is still live.
    const { h } = await store.resolveAgent(session.id, "main");
    await until(async () => (await store.liveTasks(h)).length === 0, 10000, "no live tasks");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a snapshot of a folder with files counts them and saves the result to App State", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const folder = join(t.work, "counted");
    await mkdir(join(folder, "sub"), { recursive: true });
    for (const [name, text] of [["a.ts", "1"], ["b.ts", "2"], ["c.md", "3"], ["sub/d.json", "{}"]]) await writeFile(join(folder, name), text);
    const session = await store.create({ name: "Snapshot", cwd: t.work, model: faux });
    const id = await start(store, session.id, "workspace-snapshot", { path: "counted" });
    await until(async () => (await run(store, session.id, id)).status === "completed", 30000, "completed");
    const done = await run(store, session.id, id);
    assert.match(done.result ?? "", /matches run #1/);
    const saved = (await sharedValue(store)).jobs["workspace-snapshot"];
    assert.equal(saved.run, 1);
    assert.equal(saved.folder, "counted");
    assert.equal(saved.files, 4);
    assert.deepEqual(saved.top.map((x: { ext: string; count: number }) => [x.ext, x.count]).sort(), [["json", 1], ["md", 1], ["ts", 2]]);
    assert.equal(saved.branch, "(not a git repo)");
    assert.equal(saved.entries, 4, "ls -1A: three files and one folder");
    // Phase summaries read like the saved data.
    assert.match(done.phases[1].summary ?? "", /^4 files: /);
    assert.equal(done.phases[2].summary, "Saved to App State /jobs/workspace-snapshot");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a change watch reports files that were added, removed and edited between checks", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const folder = join(t.work, "watched");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "keep.txt"), "same");
    await writeFile(join(folder, "edit.txt"), "before");
    await writeFile(join(folder, "gone.txt"), "bye");
    const session = await store.create({ name: "Watch", cwd: t.work, model: faux });
    const id = await start(store, session.id, "change-watch", { path: "watched", checks: 3, interval_seconds: 2 });
    await until(async () => ((await run(store, session.id, id)).phases[1].progress?.done ?? 0) >= 1, 20000, "first check");
    await writeFile(join(folder, "edit.txt"), "after, and longer");
    await writeFile(join(folder, "new.txt"), "hello");
    await rm(join(folder, "gone.txt"));
    await until(async () => (await run(store, session.id, id)).status === "completed", 40000, "completed");
    const saved = (await sharedValue(store)).jobs["change-watch"];
    assert.equal(saved.folder, "watched");
    assert.equal(saved.checks, 3);
    assert.deepEqual((saved.changes as string[]).slice().sort(), ["+ new.txt", "- gone.txt", "~ edit.txt"]);
    assert.equal((await run(store, session.id, id)).result, "3 changes saved to App State");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("aborting one task stops that run only", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "AbortTask", cwd: t.work, model: faux });
    const slow = await start(store, session.id, "change-watch", { checks: 20, interval_seconds: 60 });
    const other = await start(store, session.id, "change-watch", { checks: 20, interval_seconds: 60 });
    await until(async () => (await run(store, session.id, slow)).phase === "watch" && (await run(store, session.id, other)).phase === "watch", 20000, "both watching");
    const { h } = await store.resolveAgent(session.id, "main");
    assert.ok(["marked", "terminal"].includes((await store.abortTask(h, slow)).status));
    await until(async () => (await run(store, session.id, slow)).status === "aborted", 20000, "slow aborted");
    const stopped = await run(store, session.id, slow);
    assert.equal(stopped.error, "Stopped");
    assert.deepEqual(stopped.phases.map((p) => p.status), ["done", "aborted", "skipped"]);
    assert.equal((await run(store, session.id, other)).status, "running", "the other run is untouched");
    const m = await store.resolveAgent(session.id, "main");
    await store.abort(m.c, true);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the agent's job tools: list, run and wait, run with bad input, check by id, by job and with no argument", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Tools", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    let n = 0;
    const turn = async (content: string) => {
      const sent = await store.send(c, { content, requestId: `jt-${++n}` });
      assert.equal((await store.settled(h, sent.id as number, 60000)).status, "done");
      const entry = (await store.entries(c, undefined, 50)).items.find((e) => e.kind === "pi.tool-result")!;
      const message = entry.model?.[0] as { toolName?: string; isError?: boolean; content?: { text?: string }[] };
      return { tool: message.toolName, error: message.isError === true, text: (message.content ?? []).map((x) => x.text ?? "").join("") };
    };

    const listed = await turn("jobs?");
    assert.equal(listed.tool, "list_durable_jobs");
    const defs = JSON.parse(listed.text) as { job: string; needsApproval: boolean; savesTo: string; inputs: Record<string, { type: string; default: unknown }>; recentRuns: unknown[] }[];
    assert.deepEqual(defs.map((d) => d.job), ["workspace-snapshot", "release-check", "change-watch"]);
    assert.deepEqual(defs.map((d) => d.needsApproval), [false, true, false]);
    assert.equal(defs[0].savesTo, "/jobs/workspace-snapshot");
    assert.deepEqual(defs[2].inputs.checks, { type: "integer", default: 5, min: 2, max: 20, description: "How many checks the watch phase runs" });
    assert.deepEqual(defs.map((d) => d.recentRuns), [[], [], []]);

    // wait: the call owns the run and returns the outcome of every phase.
    const waited = await turn("job: workspace-snapshot wait");
    assert.equal(waited.tool, "run_durable_job");
    assert.equal(waited.error, false);
    assert.match(waited.text, /^Workspace snapshot run #1 completed: App State matches run #1\./);
    assert.match(waited.text, /✓ 1\/4 Scan: /);
    assert.match(waited.text, /✓ 4\/4 Verify: App State matches run #1/);
    assert.match(waited.text, /Result saved to App State \/jobs\/workspace-snapshot\.$/);

    // The call that waited owned the run, so it is not a background run.
    const items = Object.values(await runs(store, session.id));
    assert.equal(items.length, 1);
    assert.equal(items[0].startedBy, "agent");
    assert.equal(items[0].background, false);

    // Bad job, bad input.
    const unknown = await turn("job: nope");
    assert.equal(unknown.error, true);
    assert.match(unknown.text, /Unknown job nope\. Jobs: workspace-snapshot, release-check, change-watch/);
    const bad = await turn('job: change-watch {"checks":1}');
    assert.equal(bad.error, true);
    assert.match(bad.text, /checks must be 2 to 20/);
    assert.equal(Object.keys(await runs(store, session.id)).length, 1, "refused calls start nothing");

    // check_durable_job: no argument lists, by job and by task id report one run.
    const list = await turn("check:");
    assert.deepEqual(JSON.parse(list.text).map((r: { job: string; run: number; status: string }) => [r.job, r.run, r.status]), [["workspace-snapshot", 1, "completed"]]);
    const byJob = JSON.parse((await turn("check: workspace-snapshot")).text);
    assert.equal(byJob.job, "workspace-snapshot");
    assert.equal(byJob.status, "completed");
    assert.equal(byJob.phases.length, 4);
    assert.equal(byJob.phase, undefined, "a finished run has no current phase");
    assert.ok(byJob.seconds > 0);
    const byId = JSON.parse((await turn(`check: ${items[0].id}`)).text);
    assert.equal(byId.taskId, items[0].id);
    const missing = await turn("check: 99999");
    assert.equal(missing.error, true);
    assert.match(missing.text, new RegExp(`No run with task id 99999 in this conversation\\. Runs: ${items[0].id} \\(workspace-snapshot #1\\)`));
    const neverRun = await turn("check: change-watch");
    assert.match(neverRun.text, /No run of change-watch in this conversation/);

    // list_durable_jobs now shows the run.
    const again = JSON.parse((await turn("jobs?")).text) as { job: string; recentRuns: { taskId: number; run: number; status: string }[] }[];
    assert.deepEqual(again[0].recentRuns, [{ taskId: items[0].id, run: 1, status: "completed", phase: "Verify" }]);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a run waits for approval inside run_durable_job and an interrupt stops the whole call", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "WaitApprove", cwd: t.work, model: faux });
    const { c } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "job: release-check wait", requestId: "wa-1" });
    assert.ok(sent.id);
    await until(async () => Object.values(await runs(store, session.id)).some((r) => r.approval === "pending"), 40000, "approval pending");
    const pending = Object.values(await runs(store, session.id))[0];
    assert.equal(pending.startedBy, "agent");
    assert.equal(pending.background, false, "the call owns this run");
    // A plain abort, not a background one, reaches a run the call owns.
    await store.abort(c, false);
    await until(async () => (await runs(store, session.id))[pending.id].status === "aborted", 20000, "aborted with the call");
    assert.equal((await runs(store, session.id))[pending.id].approval, "cancelled");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("cancelling just the approval task ends the run as aborted with 'Approval cancelled'", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "CancelApproval", cwd: t.work, model: faux });
    const id = await start(store, session.id, "release-check");
    await until(async () => (await run(store, session.id, id)).approval === "pending", 30000, "approval pending");
    const { h } = await store.resolveAgent(session.id, "main");
    const approval = (await store.liveTasks(h)).find((x) => x.kind === "demo.job-approval");
    assert.ok(approval, "the approval is its own task");
    assert.equal(approval.owner, id, "owned by the run");
    await store.abortTask(h, approval.id);
    await until(async () => (await run(store, session.id, id)).status === "aborted", 20000, "aborted");
    const aborted = await run(store, session.id, id);
    assert.equal(aborted.error, "Approval cancelled");
    assert.equal(aborted.approval, "cancelled");
    assert.deepEqual(aborted.phases.map((p) => p.status), ["done", "done", "aborted", "skipped", "skipped"]);
    assert.ok(aborted.phases[2].steps.some((s) => s.kind === "approval" && s.status === "error" && s.label === "Approval cancelled"));
    assert.equal((await sharedValue(store)).jobs?.["release-check"], undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
