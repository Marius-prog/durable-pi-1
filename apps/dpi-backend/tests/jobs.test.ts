// jobs.ts without a harness: the job definitions, input validation, and how a run is registered.
// The phases themselves (real shell commands, restarts, approval) run in store.test.ts and jobs-run.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { JobDef, JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { JOB_DEFS, JobRuns, createJobs, jobDef, resolveJobInput } from "../src/jobs.js";
import type { SharedState } from "../src/shared-state.js";

const def = (id: string) => jobDef(id)!;

describe("job definitions", () => {
  test("the device ships the three example jobs, in a stable order", () => {
    assert.deepEqual(JOB_DEFS.map((d) => d.id), ["workspace-snapshot", "release-check", "change-watch"]);
  });

  test("jobDef finds a job by id and nothing else", () => {
    assert.equal(jobDef("release-check")?.title, "Release check");
    assert.equal(jobDef("nope"), undefined);
    assert.equal(jobDef(""), undefined);
    assert.equal(jobDef("RELEASE-CHECK"), undefined, "ids are case-sensitive");
  });

  test("every job has unique phase ids, unique input names, a result path under /jobs and positive typical seconds", () => {
    for (const d of JOB_DEFS) {
      assert.ok(d.title && d.summary, d.id);
      assert.equal(new Set(d.phases.map((p) => p.id)).size, d.phases.length, `${d.id} phase ids`);
      assert.equal(new Set(d.inputs.map((i) => i.name)).size, d.inputs.length, `${d.id} input names`);
      for (const p of d.phases) assert.ok(p.label && p.summary, `${d.id}/${p.id}`);
      assert.equal(d.resultPath, `/jobs/${d.id}`);
      assert.ok(d.seconds > 0);
    }
  });

  test("a job waits for a person exactly when it has an approval phase", () => {
    for (const d of JOB_DEFS) assert.equal(d.approval, d.phases.some((p) => p.kind === "approval"), d.id);
    assert.deepEqual(JOB_DEFS.filter((d) => d.approval).map((d) => d.id), ["release-check"]);
    // The approval comes after the work it gates and before anything that publishes.
    const phases = def("release-check").phases.map((p) => p.id);
    assert.deepEqual(phases, ["plan", "gather", "approve", "publish", "verify"]);
  });

  test("change-watch repeats its watch phase and the others do not repeat", () => {
    assert.deepEqual(JOB_DEFS.flatMap((d) => d.phases.filter((p) => p.kind === "repeat").map((p) => `${d.id}/${p.id}`)), ["change-watch/watch"]);
  });

  test("the defaults of every job are themselves valid input", () => {
    for (const d of JOB_DEFS) {
      const resolved = resolveJobInput(d, {});
      assert.deepEqual(resolved, Object.fromEntries(d.inputs.map((i) => [i.name, i.default])), d.id);
    }
  });
});

describe("resolveJobInput", () => {
  test("fills defaults for missing, undefined and null input", () => {
    assert.deepEqual(resolveJobInput(def("change-watch"), {}), { path: ".", checks: 5, interval_seconds: 4 });
    assert.deepEqual(resolveJobInput(def("change-watch"), undefined), { path: ".", checks: 5, interval_seconds: 4 });
    assert.deepEqual(resolveJobInput(def("change-watch"), null), { path: ".", checks: 5, interval_seconds: 4 });
    assert.deepEqual(resolveJobInput(def("change-watch"), { checks: undefined }), { path: ".", checks: 5, interval_seconds: 4 });
  });

  test("keeps the values it is given and trims strings", () => {
    assert.deepEqual(resolveJobInput(def("change-watch"), { path: "  src/app  ", checks: 3, interval_seconds: 10 }), {
      path: "src/app",
      checks: 3,
      interval_seconds: 10,
    });
  });

  test("accepts integers given as numeric strings, as a form would send them", () => {
    assert.deepEqual(resolveJobInput(def("release-check"), { commits: "7" }), { commits: 7 });
    assert.deepEqual(resolveJobInput(def("release-check"), { commits: " 7 " }), { commits: 7 });
  });

  test("integer bounds are inclusive and the message states them", () => {
    assert.equal(resolveJobInput(def("release-check"), { commits: 1 }).commits, 1);
    assert.equal(resolveJobInput(def("release-check"), { commits: 20 }).commits, 20);
    assert.throws(() => resolveJobInput(def("release-check"), { commits: 0 }), /commits must be 1 to 20/);
    assert.throws(() => resolveJobInput(def("release-check"), { commits: 21 }), /commits must be 1 to 20/);
    assert.throws(() => resolveJobInput(def("change-watch"), { interval_seconds: 1 }), /interval_seconds must be 2 to 60/);
    assert.throws(() => resolveJobInput(def("change-watch"), { checks: -3 }), /checks must be 2 to 20/);
  });

  test("rejects an integer input that is not an integer", () => {
    for (const bad of [1.5, "1.5", "abc", "", "   ", NaN, Infinity, true, [], {}, "12abc"])
      assert.throws(() => resolveJobInput(def("release-check"), { commits: bad }), /commits must be an integer/, JSON.stringify(bad) ?? String(bad));
  });

  test("an empty string for an integer is an error, not the default", () => {
    assert.throws(() => resolveJobInput(def("release-check"), { commits: "" }), /must be an integer/);
  });

  test("rejects a string input that is empty, blank, non-string or holds a NUL byte", () => {
    for (const bad of ["", "   ", 5, true, ["x"], { a: 1 }, "a\0b"])
      assert.throws(() => resolveJobInput(def("workspace-snapshot"), { path: bad }), /path must be a non-empty string/, JSON.stringify(bad));
  });

  test("names every unknown input and lists the valid ones", () => {
    assert.throws(
      () => resolveJobInput(def("workspace-snapshot"), { depth: 2, verbose: true }),
      (e: Error) => /workspace-snapshot has no input depth, verbose\. Inputs: path/.test(e.message),
    );
    assert.throws(() => resolveJobInput({ ...def("workspace-snapshot"), inputs: [] }, { x: 1 }), /Inputs: none/);
  });

  test("the input itself must be an object", () => {
    for (const bad of [[], [1], "path", 5, true])
      assert.throws(() => resolveJobInput(def("workspace-snapshot"), bad), /input must be an object/, JSON.stringify(bad));
  });

  test("does not mutate the input it is given", () => {
    const given = { checks: "4" };
    resolveJobInput(def("change-watch"), given);
    assert.deepEqual(given, { checks: "4" });
  });
});

describe("createJobs", () => {
  /** Just enough of a transaction to register runs: ids count up, documents are plain objects. */
  function fakeTx() {
    const docs = new Map<string, JobRunsDoc>();
    const created: { task: { name: string }; input: unknown; options: Record<string, unknown> }[] = [];
    let next = 10;
    const tx = {
      async createTask(task: { name?: string; definition?: { name: string } }, input: unknown, options: Record<string, unknown>) {
        created.push({ task: { name: task.definition?.name ?? String(task.name) }, input, options });
        return next++;
      },
      async doc(token: unknown, conversationId: number) {
        assert.equal(token, JobRuns);
        if (!docs.has(String(conversationId))) docs.set(String(conversationId), { counts: {}, items: {} });
        return docs.get(String(conversationId))!;
      },
    };
    return { tx: tx as never, docs, created };
  }
  const jobs = () => createJobs({ shared: {} as SharedState, sessionId: "s1" });

  test("exposes the definitions and one task per job plus the approval task", () => {
    const j = jobs();
    assert.equal(j.defs, JOB_DEFS);
    assert.equal(j.tasks.length, JOB_DEFS.length + 1);
  });

  test("a job's task carries one phase per job phase, so the task graph and the run record agree", () => {
    const j = jobs();
    for (const [i, d] of JOB_DEFS.entries()) {
      const task = j.tasks[i] as unknown as { definition: { name: string; phases: Record<string, unknown> } };
      assert.equal(task.definition.name, `demo.job.${d.id}`);
      assert.deepEqual(Object.keys(task.definition.phases), d.phases.map((p) => p.id));
    }
    const approval = j.tasks.at(-1) as unknown as { definition: { name: string } };
    assert.equal(approval.definition.name, "demo.job-approval");
  });

  test("start records a running run with its phases pending, and numbers runs per job", async () => {
    const { tx, docs, created } = fakeTx();
    const j = jobs();
    const a = await j.start(tx, 1 as never, { def: def("workspace-snapshot"), input: { path: "." }, startedBy: "you", now: 1000 });
    const b = await j.start(tx, 1 as never, { def: def("workspace-snapshot"), input: { path: "src" }, startedBy: "you", now: 2000 });
    const c = await j.start(tx, 1 as never, { def: def("change-watch"), input: { path: ".", checks: 2, interval_seconds: 2 }, startedBy: "you", now: 3000 });
    const doc = docs.get("1")!;
    assert.deepEqual(doc.counts, { "workspace-snapshot": 2, "change-watch": 1 });
    assert.deepEqual([doc.items[String(a)].run, doc.items[String(b)].run, doc.items[String(c)].run], [1, 2, 1]);
    const run = doc.items[String(a)];
    assert.equal(run.id, a);
    assert.equal(run.job, "workspace-snapshot");
    assert.equal(run.title, "Workspace snapshot");
    assert.equal(run.status, "running");
    assert.equal(run.phase, "scan");
    assert.equal(run.startedBy, "you");
    assert.equal(run.startedAt, 1000);
    assert.equal(run.updatedAt, 1000);
    assert.equal(run.resumed, 0);
    assert.equal("toolCallId" in run, false);
    assert.deepEqual(run.phases.map((p) => [p.id, p.status, p.steps]), [["scan", "pending", []], ["measure", "pending", []], ["save", "pending", []], ["verify", "pending", []]]);
    assert.deepEqual(doc.items[String(b)].input, { path: "src" });
    assert.deepEqual(created.map((x) => x.task.name), ["demo.job.workspace-snapshot", "demo.job.workspace-snapshot", "demo.job.change-watch"]);
    assert.deepEqual(created[0].input, { job: "workspace-snapshot", input: { path: "." } });
  });

  test("without an owner the conversation owns the run in the background; with one the call owns it", async () => {
    const { tx, docs, created } = fakeTx();
    const j = jobs();
    const bg = await j.start(tx, 1 as never, { def: def("workspace-snapshot"), input: { path: "." }, startedBy: "you", now: 1 });
    const owned = await j.start(tx, 1 as never, { def: def("workspace-snapshot"), input: { path: "." }, startedBy: "agent", toolCallId: "call_1", owner: 77 as never, now: 2 });
    assert.deepEqual(created[0].options, { ownership: { kind: "conversation" }, background: true });
    assert.deepEqual(created[1].options, { ownership: { kind: "task", taskId: 77 }, background: false });
    const doc = docs.get("1")!;
    assert.equal(doc.items[String(bg)].background, true);
    assert.equal(doc.items[String(owned)].background, false);
    assert.equal(doc.items[String(owned)].startedBy, "agent");
    assert.equal(doc.items[String(owned)].toolCallId, "call_1");
  });

  test("runs of different conversations are kept apart", async () => {
    const { tx, docs } = fakeTx();
    const j = jobs();
    await j.start(tx, 1 as never, { def: def("release-check"), input: { commits: 5 }, startedBy: "you", now: 1 });
    await j.start(tx, 2 as never, { def: def("release-check"), input: { commits: 5 }, startedBy: "you", now: 1 });
    assert.deepEqual(docs.get("1")!.counts, { "release-check": 1 });
    assert.deepEqual(docs.get("2")!.counts, { "release-check": 1 });
  });

  test("only the newest 30 run records are kept, while the per-job count keeps rising", async () => {
    const { tx, docs } = fakeTx();
    const j = jobs();
    const ids: number[] = [];
    for (let i = 0; i < 35; i++) ids.push((await j.start(tx, 1 as never, { def: def("workspace-snapshot"), input: { path: "." }, startedBy: "you", now: i })) as number);
    const doc = docs.get("1")!;
    const kept = Object.keys(doc.items).map(Number).sort((a, b) => a - b);
    assert.equal(kept.length, 30);
    assert.deepEqual(kept, ids.slice(5));
    assert.equal(doc.counts["workspace-snapshot"], 35);
    assert.equal(doc.items[String(ids[34])].run, 35);
  });
});

test("every job definition is JSON-safe, since it goes to clients in GET /v1/device", () => {
  const copy = JSON.parse(JSON.stringify(JOB_DEFS)) as JobDef[];
  assert.deepEqual(copy, JOB_DEFS);
});
