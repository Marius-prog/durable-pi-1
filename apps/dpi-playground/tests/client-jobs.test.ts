// jobs.ts: the durable-job views over the agent's `demo.job-runs` document, and the actions on them.
import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Frame } from "../../dpi-sdk/src/api.js";
import type { JobDef, JobRun } from "../../dpi-sdk/src/jobs.js";
import {
  B,
  T,
  agentOf,
  browser,
  fetched,
  m,
  open,
  resetClient,
  snapshot,
  teardownClient,
  toast,
} from "./client-fixture.js";
import { delay, until } from "./support.js";

after(teardownClient);
beforeEach(resetClient);
// startJob() scrolls to the run's card on a zero-delay timer: let it fire before the next test or the teardown.
afterEach(() => delay(10));

const def = (id: string): JobDef => ({
  id,
  title: `Job ${id}`,
  summary: "",
  phases: [],
  inputs: [],
  approval: false,
  resultPath: "x",
  seconds: 5,
});
const run = (id: number, extra: Partial<JobRun> = {}): JobRun =>
  ({
    id,
    job: "j",
    title: "T",
    run: 1,
    input: {},
    startedBy: "you",
    background: false,
    status: "running",
    phases: [],
    resumed: 0,
    startedAt: 1,
    updatedAt: 1,
    ...extra,
  }) as JobRun;
const runsDoc = (...runs: JobRun[]): Frame => ({
  type: "doc",
  kind: "demo.job-runs",
  value: { counts: {}, items: Object.fromEntries(runs.map((r) => [String(r.id), r])) },
});

describe("seconds()", () => {
  test("short times are milliseconds, then seconds with one decimal, then minutes and seconds", () => {
    const s = m.jobs.seconds;
    assert.equal(s(0), "0ms");
    assert.equal(s(-5), "0ms", "never negative");
    assert.equal(s(0.4), "0ms");
    assert.equal(s(999), "999ms");
    assert.equal(s(1000), "1.0s");
    assert.equal(s(1250), "1.3s");
    assert.equal(s(59_000), "59.0s");
    assert.equal(s(60_000), "1m 0s");
    assert.equal(s(61_500), "1m 2s");
    assert.equal(s(125_400), "2m 5s");
    assert.equal(s(3_600_000), "60m 0s", "there is no hour unit");
  });

  test(
    "a time just under a whole minute does not read 60s",
    { todo: "119.6 seconds prints 1m 60s" },
    () => {
      assert.equal(m.jobs.seconds(119_600), "2m 0s");
    },
  );
});

describe("views", () => {
  test("jobDefs are the device's, and jobDef() finds one by id", async () => {
    assert.deepEqual(m.jobs.jobDefs.value, []);
    await open([agentOf(1)], { info: { jobs: [def("a"), def("b")] } as never });
    assert.deepEqual(
      m.jobs.jobDefs.value.map((d) => d.id),
      ["a", "b"],
    );
    assert.equal(m.jobs.jobDef("b")?.title, "Job b");
    assert.equal(m.jobs.jobDef("zzz"), undefined);
  });

  test("jobRuns come from the agent's job-runs document, newest first, and can be found by id or tool call", async () => {
    const o = await open();
    assert.deepEqual(m.jobs.jobRuns.value, []);
    o.agent(snapshot());
    o.agent(runsDoc(run(3), run(11, { toolCallId: "call-x" }), run(7)));
    assert.deepEqual(
      m.jobs.jobRuns.value.map((r) => r.id),
      [11, 7, 3],
    );
    assert.equal(m.jobs.runById(7)?.id, 7);
    assert.equal(m.jobs.runById(8), undefined);
    assert.equal(m.jobs.runByCall("call-x")?.id, 11);
    assert.equal(m.jobs.runByCall("nope"), undefined);
  });

  test("the shared clock is a number", () => {
    assert.equal(typeof m.jobs.now.value, "number");
  });
});

describe("actions", () => {
  test("startJob() starts the job on the agent, tells the user and scrolls to its card", async () => {
    await open();
    const card = browser.document.add('[data-job-run="9"]');
    browser.fetch.handler = (c) => (c.url.endsWith("/demo/jobs") ? { body: { taskId: 9 } } : {});
    await m.jobs.startJob(def("scan"));
    assert.deepEqual(fetched("POST", `${B}/agents/1/demo/jobs`)[0].body, { job: "scan" });
    assert.equal(toast(), "Job scan started. It runs in the chat.");
    await until(() => card.scrolled.length === 1, 1000, "scroll");
    assert.deepEqual(card.scrolled[0], { behavior: "smooth", block: "center" });
    assert.equal(m.jobs.pending.value, undefined, "the button is free again");
  });

  test("revealRun() closes a narrow screen's inspector first", async () => {
    browser.media.change(true);
    m.store.ui.inspectorOverlay = true;
    m.jobs.revealRun(4);
    assert.equal(m.store.ui.inspectorOverlay, false);
    await delay(20);
    assert.ok(browser.document.queries.includes('[data-job-run="4"]'));
  });

  test("a failing start shows the error and does not claim success", async () => {
    await open();
    browser.fetch.handler = () => ({
      status: 400,
      body: { error: { code: "invalid", message: "bad input" } },
    });
    await m.jobs.startJob(def("scan"));
    assert.equal(m.store.ui.error, "bad input");
    assert.equal(toast(), "");
    assert.equal(m.jobs.pending.value, undefined);
  });

  test("only one job action runs at a time: a second click while one is in flight is ignored", async () => {
    await open();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    browser.fetch.handler = async () => (await gate, { body: { taskId: 1 } });
    const first = m.jobs.startJob(def("a"));
    await until(() => m.jobs.pending.value === "start:a", 1000, "pending");
    await m.jobs.startJob(def("b"));
    await m.jobs.decide(run(5), true);
    release();
    await first;
    assert.equal(browser.fetch.calls.filter((c) => c.method === "POST").length, 1);
  });

  test("decide() posts the approval for the run", async () => {
    await open();
    await m.jobs.decide(run(5), true);
    assert.deepEqual(fetched("POST", `${B}/agents/1/demo/jobs/5/approval`)[0].body, {
      approved: true,
    });
    await m.jobs.decide(run(5), false);
    assert.deepEqual(fetched("POST", `${B}/agents/1/demo/jobs/5/approval`)[1].body, {
      approved: false,
    });
  });

  test("stopRun() aborts the run's task on the session", async () => {
    await open();
    await m.jobs.stopRun(run(12));
    assert.deepEqual(fetched("POST", `${B}/tasks/12/abort`)[0].body, {});
  });

  test("openAgent() selects another agent of the same workspace, and does nothing with nothing selected", async () => {
    m.jobs.openAgent(3);
    assert.equal(m.store.selected.value, undefined);
    await open();
    m.jobs.openAgent(3);
    assert.deepEqual(m.store.selected.value, { ...T, agentId: 3 });
  });
});
