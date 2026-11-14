// REST v1: device info, directory browsing, documents, the demo state and job routes, and stream request errors.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { until } from "./helpers.js";
import { startRest } from "./rest.js";

describe("REST v1: device, documents and demo routes", () => {
  let rest: Awaited<ReturnType<typeof startRest>>;
  before(async () => void (rest = await startRest()));
  after(() => rest?.stop());
  const call = (...args: Parameters<typeof rest.call>) => rest.call(...args);
  const errorOf = (...args: Parameters<typeof rest.errorOf>) => rest.errorOf(...args);
  const newSession = () => rest.newSession();
  const shared = async () => (await call("GET", "/v1/docs/app.shared-state")).body as { value: Record<string, any>; revision: number };

  describe("device and directories", () => {
    test("device info", async () => {
      const r = await call("GET", "/v1/device");
      assert.equal(r.status, 200);
      assert.equal(r.body.name, "routes-box");
      assert.equal(r.body.apiVersion, 1);
      assert.match(r.body.uid, /^[0-9a-f-]{36}$/);
      assert.deepEqual(r.body.capabilities, ["events", "docs", "demo", "jobs"]);
      assert.deepEqual(r.body.startDirs, [rest.t.work]);
      assert.equal(r.body.defaultModel, "echo");
      assert.deepEqual(r.body.models.map((m: { id: string; provider: string }) => [m.provider, m.id]), [["faux", "echo"]]);
      assert.ok(r.body.storage.dataDir.startsWith(join(rest.t.root, "home")));
      assert.match(r.body.platform, /node v/);
      assert.ok(r.body.startedAt <= Date.now());
      assert.ok(!JSON.stringify(r.body).includes(rest.token), "the token is never echoed");
    });

    test("browsing: start dirs by default, a folder lists its sub-folders, bad paths are 404", async () => {
      for (const dir of ["b-dir", "a-dir", ".hidden", "node_modules"]) await mkdir(join(rest.t.work, "browse", dir), { recursive: true });
      const dirs = (path: string) => call("GET", `/v1/fs/dirs?path=${encodeURIComponent(path)}`);
      assert.deepEqual((await call("GET", "/v1/fs/dirs")).body, { path: "", dirs: [{ name: rest.t.work, path: rest.t.work }] });
      const listing = (await dirs(join(rest.t.work, "browse"))).body;
      assert.deepEqual(listing.dirs.map((d: { name: string }) => d.name), ["a-dir", "b-dir"], "sorted, no dot folders, no node_modules");
      assert.equal(listing.parent, rest.t.work);
      assert.equal(listing.path, join(rest.t.work, "browse"));
      errorOf(await dirs(join(rest.t.work, "browse", "missing")), 404, "not_found", /Not a directory on routes-box/);
      assert.equal((await dirs("/")).body.parent, undefined, "the root has no parent");
    });
  });

  describe("documents", () => {
    test("agent documents: known kinds are readable, unknown ones are 404", async () => {
      const s = await newSession();
      assert.deepEqual((await call("GET", `${s.main}/docs/demo.job-runs`)).body, { kind: "demo.job-runs", value: { counts: {}, items: {} } });
      const workspace = (await call("GET", `${s.main}/docs/demo.workspace`)).body;
      assert.equal(workspace.kind, "demo.workspace");
      assert.equal(workspace.value.counter, 0);
      errorOf(await call("GET", `${s.main}/docs/ext.system-prompts`), 404, "not_found", /Unknown agent document ext\.system-prompts\. Known: demo\.job-runs, demo\.workspace/);
    });

    test("device documents: only app.shared-state, and an unknown kind is a 400", async () => {
      const r = await call("GET", "/v1/docs/app.shared-state");
      assert.equal(r.status, 200);
      assert.equal(r.body.kind, "app.shared-state");
      assert.equal(typeof r.body.revision, "number");
      assert.equal(typeof r.body.value, "object");
      errorOf(await call("GET", "/v1/docs/demo.workspace"), 400, "invalid", "Unknown device document demo.workspace");
    });
  });

  describe("demo: shared state", () => {
    test("needs an operation or one of the shortcuts", async () => {
      const s = await newSession();
      const state = (body: unknown) => call("POST", `${s.main}/demo/state`, body);
      errorOf(await state({}), 400, "invalid", "A state operation is required");
      errorOf(await state({ goal: 5 }), 400, "invalid", "A state operation is required");
      errorOf(await state({ note: 5 }), 400, "invalid", "A state operation is required");
      errorOf(await state({ increment: "yes" }), 400, "invalid", "A state operation is required");
    });

    test("the goal, increment and note shortcuts change App State and add a transcript entry each", async () => {
      const s = await newSession();
      const state = (body: unknown) => call("POST", `${s.main}/demo/state`, body);
      const before = await shared();
      const goal = await state({ goal: "ship it" });
      assert.equal(goal.body.ok, true);
      assert.equal(goal.body.value.goal, "ship it");
      assert.equal(goal.body.revision, before.revision + 1);
      assert.equal((await state({ increment: true })).body.value.counter, before.value.counter + 1);
      assert.equal((await state({ note: "remember this" })).body.value.notes.at(-1), "remember this");
      const entries = (await call("GET", `${s.main}/entries`)).body.items.filter((e: { kind: string }) => e.kind === "demo.state-change");
      assert.equal(entries.length, 3);
    });

    test("an explicit operation is checked: bad pointers, missing fields and wrong types are 400, and nothing changes", async () => {
      const s = await newSession();
      const state = (body: unknown) => call("POST", `${s.main}/demo/state`, body);
      const before = await shared();
      errorOf(await state({ operation: "update", path: "counter", value: 1 }), 400, "invalid", /JSON Pointer/);
      errorOf(await state({ operation: "update", path: "/nope", value: 1 }), 400, "invalid", /does not exist/);
      errorOf(await state({ operation: "create", path: "/goal", value: "x" }), 400, "invalid", /already exists/);
      errorOf(await state({ operation: "increment", path: "/goal", value: 1 }), 400, "invalid", /Increment requires numbers/);
      errorOf(await state({ operation: "update", path: "/a/~2", value: 1 }), 400, "invalid", /escape/);
      errorOf(await state({ operation: "create", path: "/__proto__", value: 1 }), 400, "invalid", /Reserved field name/);
      errorOf(await state({ operation: "update", path: "", value: [] }), 400, "invalid", /state root must be a JSON object/);
      errorOf(await state({ operation: "destroy", path: "/goal" }), 400, "invalid", "Invalid state operation");
      errorOf(await state({ operation: "create", path: "/big", value: "x".repeat(100_001) }), 400, "invalid", /under 100,000 characters/);
      const after = await shared();
      assert.deepEqual(after.value, before.value);
      assert.equal(after.revision, before.revision);
    });

    test("expectedRevision makes a stale edit a 409 conflict", async () => {
      const s = await newSession();
      const { revision } = await shared();
      const edit = (path: string) => call("POST", `${s.main}/demo/state`, { operation: "create", path, value: 1, expectedRevision: revision });
      assert.equal((await edit("/rev-a")).status, 200);
      errorOf(await edit("/rev-b"), 409, "conflict", /changed while you were editing/);
      assert.equal((await shared()).value["rev-b"], undefined);
    });

    test("shared state is device-wide: two sessions edit the same object", async () => {
      const a = await newSession();
      const b = await newSession();
      await call("POST", `${a.main}/demo/state`, { operation: "create", path: "/across", value: "yes" });
      assert.equal((await call("POST", `${b.main}/demo/state`, { operation: "update", path: "/across", value: "still" })).body.value.across, "still");
    });
  });

  describe("demo: jobs", () => {
    test("starting a job validates its name and inputs, and records nothing when it refuses", async () => {
      const s = await newSession();
      const start = (body: unknown) => call("POST", `${s.main}/demo/jobs`, body);
      errorOf(await start({}), 400, "invalid", "job must be one of workspace-snapshot, release-check, change-watch");
      errorOf(await start({ job: 5 }), 400, "invalid", /job must be one of/);
      errorOf(await start({ job: "nope" }), 400, "invalid", /job must be one of/);
      errorOf(await start({ job: "change-watch", input: { checks: 1 } }), 400, "invalid", "checks must be 2 to 20");
      errorOf(await start({ job: "change-watch", input: { interval_seconds: 61 } }), 400, "invalid", "interval_seconds must be 2 to 60");
      errorOf(await start({ job: "change-watch", input: { speed: 1 } }), 400, "invalid", /has no input speed/);
      errorOf(await start({ job: "workspace-snapshot", input: { path: "" } }), 400, "invalid", /path must be a non-empty string/);
      errorOf(await start({ job: "workspace-snapshot", input: [] }), 400, "invalid", "input must be an object");
      assert.deepEqual((await call("GET", `${s.main}/docs/demo.job-runs`)).body.value, { counts: {}, items: {} });
    });

    test("approving a run that is not waiting is a 409, and the decision must be a boolean", async () => {
      const s = await newSession();
      const approve = (taskId: string | number, body: unknown) => call("POST", `${s.main}/demo/jobs/${taskId}/approval`, body);
      errorOf(await approve(1, { approved: "yes" }), 400, "invalid", "approved must be a boolean");
      errorOf(await approve(1, {}), 400, "invalid", "approved must be a boolean");
      errorOf(await approve("abc", { approved: true }), 400, "invalid", "taskId must be an integer");
      errorOf(await approve(1, { approved: true }), 409, "conflict", "No pending approval for that run");
      errorOf(await approve(99999, { approved: false }), 409, "conflict", "No pending approval for that run");
    });

    test("a job started by a person is recorded, shows in the entries and finishes", async () => {
      const s = await newSession();
      await mkdir(join(rest.t.work, "snap"), { recursive: true });
      const start = await call("POST", `${s.main}/demo/jobs`, { job: "workspace-snapshot", input: { path: "snap" } });
      assert.equal(start.status, 201);
      const id = String(start.body.taskId);
      const run = async () => (await call("GET", `${s.main}/docs/demo.job-runs`)).body.value.items[id];
      assert.equal((await run()).startedBy, "you");
      assert.deepEqual((await run()).input, { path: "snap" });
      await until(async () => (await run()).status === "completed", 30000, "snapshot run");
      assert.deepEqual((await run()).phases.map((p: { status: string }) => p.status), ["done", "done", "done", "done"]);
      const entry = (await call("GET", `${s.main}/entries`)).body.items.find((e: { kind: string }) => e.kind === "demo.job");
      assert.equal(entry.data.job, "workspace-snapshot");
      assert.equal(entry.data.text, "Started Workspace snapshot");
    });
  });

  describe("streams: request errors", () => {
    test("device, session and agent streams refuse bad requests before streaming", async () => {
      const s = await newSession();
      errorOf(await call("GET", "/v1/events?docs=nope"), 400, "invalid", /Unknown document nope\. Allowed: app\.shared-state/);
      errorOf(await call("GET", `${s.main}/events?docs=app.shared-state`), 400, "invalid", /Unknown document app\.shared-state\. Allowed: demo\.job-runs, demo\.workspace/);
      errorOf(await call("GET", "/v1/sessions/ghost/events"), 404, "not_found");
      errorOf(await call("GET", `${s.base}/agents/ghost/events`), 404, "not_found");
    });
  });
});
