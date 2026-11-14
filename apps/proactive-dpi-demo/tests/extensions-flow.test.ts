// The incident agent's tools and the durable deploy task, run inside a real Durable Pi harness on a temp SQLite
// file with a scripted faux model. No network and no real model: every assistant turn is written out here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configure } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { FIX, REGRESSION, delay, git, insertLog, makeCheckoutRepo, makeRow, openLogDb, tempDir, until } from "./helpers.ts";
import { callTools, ctx, openFixture, say, type Conversation } from "./harness-fixture.ts";
import { Deploys, Incidents } from "../apps/proactive-dpi-be/src/extensions.ts";
import { WatchStore } from "../apps/proactive-dpi-be/src/watch-store.ts";
import { ensureWorktree } from "../apps/proactive-dpi-be/src/repo.ts";
import { writeControl } from "../shared/log-store.ts";
import type { Deploy } from "../shared/types.ts";

const t = tempDir();
let repo: string;
let logs: DatabaseSync;
let store: WatchStore;
let fx: Awaited<ReturnType<typeof openFixture>>;
let seq = 0;

before(async () => {
  repo = makeCheckoutRepo(t.root);
  logs = openLogDb(t.root);
  store = new WatchStore(join(t.root, "watch.sqlite"), join(t.root, "logs.sqlite"));
  fx = await openFixture({ dir: t.root, repoDir: repo, store });
});
after(async () => {
  await fx.close();
  store.close();
  logs.close();
  t.cleanup();
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

async function newIncident() {
  const n = ++seq;
  const worktree = join(t.root, "incidents", `inc-${String(n).padStart(4, "0")}`);
  const branch = `incident/inc-${String(n).padStart(4, "0")}`;
  ensureWorktree(branch, worktree, repo);
  const incident = await fx.openIncident({ worktree, branch });
  assert.equal(incident.id, `INC-${String(n).padStart(4, "0")}`);
  return { incident, worktree, conv: await fx.conversationOf(incident) };
}

const update = (status: string, summary = `now ${status}`, extra: Record<string, unknown> = {}) => ({
  name: "update_incident",
  args: { status, summary, ...extra },
});
const submit = (extra: Record<string, unknown> = {}) => ({
  name: "submit_fix",
  args: {
    summary: "Guests no longer crash checkout.",
    root_cause: "loyaltyDiscount dereferenced customer.loyalty for guests.",
    fix: "Return 0 when the customer has no loyalty data.",
    commit_message: "fix(pricing): guests have no loyalty data",
    ...extra,
  },
});

const current = async (id: string) => (await fx.incidents()).find((i) => i.id === id)!;
const deploys = async () => Object.values((await fx.harness.snapshot(Deploys, ctx))?.items ?? {}) as Deploy[];
const errorOf = (r: { text: string; isError: boolean }) => (r.isError ? r.text.replace(/^<harness>\n\[error\] /, "").replace(/\n<\/harness>$/, "") : null);

/** Walks an incident to fix_in_progress, writes the fix and its test into the worktree, and submits it. */
async function readyIncident() {
  const made = await newIncident();
  const { results } = await fx.run(made.conv, [
    callTools(
      update("investigating"),
      update("root_cause_found", "found it", { root_cause: "guests have no loyalty" }),
      update("fix_in_progress"),
      { name: "write", args: { path: "src/pricing/loyalty.ts", content: FIX } },
      { name: "write", args: { path: "test/guest.test.ts", content: REGRESSION } },
      submit(),
    ),
    say("Ready for review."),
  ]);
  assert.deepEqual(results.map((r) => r.isError), Array(6).fill(false), JSON.stringify(results));
  const incident = await current(made.incident.id);
  assert.equal(incident.status, "ready_for_review");
  return { ...made, incident };
}

async function awaitDeploy(incidentId: string, status: Deploy["status"] = "awaiting_approval", skip = 0) {
  let found: Deploy | undefined;
  await until(async () => {
    const all = (await deploys()).filter((d) => d.incidentId === incidentId && d.status === status);
    found = all[skip];
    return !!found;
  }, 10_000, `deploy ${status}`);
  return found!;
}

/** What Ops.decideDeploy does: the engineer's click, committed into the shared document. */
async function decide(id: number, approved: boolean, note: string | null = null) {
  await fx.harness.commit(async (tx) => {
    const request = (await tx.doc(Deploys)).items[String(id)];
    assert.equal(request.status, "awaiting_approval");
    request.status = approved ? "deploying" : "declined";
    request.decidedAt = Date.now();
    request.note = note;
  }, ctx);
}

/** What the logs process does once asked: roll the revision out, acknowledge, and serve three guest checkouts. */
async function rollOut(deployId: number, errors = 0) {
  let request!: { id: number; commit: string; revision: string };
  await until(() => {
    const raw = store.control().deploy_request;
    if (!raw) return false;
    request = JSON.parse(raw);
    return request.id === deployId;
  }, 10_000, "the rollout request");
  writeControl(logs, "deployed", JSON.stringify({ ...request, at: Date.now() }));
  for (let i = 0; i < 3; i++)
    insertLog(
      logs,
      makeRow({
        id: 0,
        revision: request.revision,
        route: "/v1/checkout",
        status: i < errors ? 500 : 200,
        severity: i < errors ? "ERROR" : "INFO",
        entry: { jsonPayload: { message: "checkout", customer: { guest: true, region: "us-ca" } } },
      }),
    );
  return request;
}

const revisionsSoFar = async () => (await deploys()).filter((d) => d.revision).length;

// ── update_incident ─────────────────────────────────────────────────────────────────────────────────

test("update_incident: stages go in order and none can be skipped", async () => {
  const { incident, conv } = await newIncident();
  const seen = fx.incidentChanges.length;
  const { results } = await fx.run(conv, [
    callTools(
      update("root_cause_found"), // refused: nothing reported yet
      update("fix_in_progress"), // refused
      update("investigating", "looking at checkout"),
      update("fix_in_progress"), // refused: root cause first
      update("root_cause_found", "guest rows have no loyalty", { root_cause: "loyalty!.tier on a guest" }),
      update("fix_in_progress", "writing the fix"),
    ),
    say("ok"),
  ]);
  assert.deepEqual(
    results.map(errorOf),
    [
      "Report investigating first. Stages go in order and none can be skipped.",
      "Report investigating first. Stages go in order and none can be skipped.",
      null,
      "Report root_cause_found first. Stages go in order and none can be skipped.",
      null,
      null,
    ],
  );
  assert.deepEqual(results.filter((r) => !r.isError).map((r) => r.text), [
    `${incident.id} is now investigating.`,
    `${incident.id} is now root_cause_found.`,
    `${incident.id} is now fix_in_progress.`,
  ]);
  const after = await current(incident.id);
  assert.equal(after.status, "fix_in_progress");
  assert.equal(after.summary, "writing the fix");
  assert.equal(after.report.rootCause, "loyalty!.tier on a guest");
  assert.deepEqual(after.timeline.map((e) => e.status), ["starting", "investigating", "root_cause_found", "fix_in_progress"], "refused reports leave no trace");
  assert.equal(after.timeline[1].summary, "looking at checkout");
  assert.ok(after.updatedAt >= incident.updatedAt);
  const changes = fx.incidentChanges.slice(seen).filter((c) => c.incident.id === incident.id);
  assert.equal(changes.length, 3, "the engineer's view is told about each accepted change only");
  assert.deepEqual(changes.map((c) => c.announce), [false, false, false]);
  assert.deepEqual(changes.map((c) => c.incident.status), ["investigating", "root_cause_found", "fix_in_progress"]);
});

test("update_incident: blocked is always allowed and the next report resumes from the last real stage", async () => {
  const { incident, conv } = await newIncident();
  const { results } = await fx.run(conv, [
    callTools(
      update("blocked", "cannot read the repo"), // allowed at the very start
      update("fix_in_progress"), // still refused: the last real stage is "starting"
      update("investigating"),
      update("root_cause_found"),
      update("blocked", "waiting on logs"),
      update("fix_in_progress"), // the last real stage is root_cause_found, so this is next
    ),
    say("ok"),
  ]);
  assert.deepEqual(results.map(errorOf), [null, "Report investigating first. Stages go in order and none can be skipped.", null, null, null, null]);
  const after = await current(incident.id);
  assert.equal(after.status, "fix_in_progress");
  assert.deepEqual(after.timeline.map((e) => e.status), ["starting", "blocked", "investigating", "root_cause_found", "blocked", "fix_in_progress"]);
});

test("update_incident: the agent cannot report ready_for_review or deployed itself", async () => {
  const { incident, conv } = await newIncident();
  const { results } = await fx.run(conv, [callTools(update("ready_for_review"), update("deployed")), say("ok")]);
  assert.deepEqual(results.map((r) => r.isError), [true, true]);
  assert.match(results[0].text, /status/i);
  const after = await current(incident.id);
  assert.equal(after.status, "starting");
  assert.equal(after.timeline.length, 1);
});

test("update_incident: a root cause is stored only when given, and never erased by a later update", async () => {
  const { incident, conv } = await newIncident();
  await fx.run(conv, [
    callTools(update("investigating"), update("root_cause_found", "x", { root_cause: "the cause" }), update("fix_in_progress", "no cause here")),
    say("ok"),
  ]);
  assert.equal((await current(incident.id)).report.rootCause, "the cause");
});

test("the incident tools refuse a conversation that owns no incident", async () => {
  const stray = await fx.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, {
      model: { provider: "faux", modelId: "echo" },
      thinkingLevel: "off",
      extensions: [CodingTools, fx.extensions.OpsTools, fx.extensions.IncidentAgent],
      cwd: repo,
    });
    return conversation.id;
  }, ctx);
  const conv = (await fx.harness.conversation(stray, ctx)) as Conversation;
  const { results } = await fx.run(conv, [callTools(update("investigating"), submit(), { name: "deploy", args: { summary: "ship" } }), say("ok")]);
  assert.deepEqual(results.map(errorOf), Array(3).fill("This conversation does not own an incident."));
});

// ── submit_fix ──────────────────────────────────────────────────────────────────────────────────────

test("submit_fix: refused until fix_in_progress has been reported", async () => {
  const { incident, conv, worktree } = await newIncident();
  const { results } = await fx.run(conv, [
    callTools(
      submit(),
      update("investigating"),
      submit(),
      update("root_cause_found"),
      submit(),
    ),
    say("ok"),
  ]);
  const refusal = "Report fix_in_progress with update_incident first.";
  assert.deepEqual(results.map(errorOf), [refusal, null, refusal, null, refusal]);
  assert.equal(git(worktree, "rev-list", "--count", "main..HEAD"), "0", "nothing was committed");
  assert.equal((await current(incident.id)).status, "root_cause_found");
});

test("submit_fix: with nothing changed or no regression test it explains and changes nothing", async () => {
  const { incident, conv, worktree } = await newIncident();
  const first = await fx.run(conv, [callTools(update("investigating"), update("root_cause_found"), update("fix_in_progress"), submit()), say("ok")]);
  assert.match(errorOf(first.results[3])!, /^Nothing differs from main yet\./);

  const second = await fx.run(conv, [callTools({ name: "write", args: { path: "src/pricing/loyalty.ts", content: FIX } }, submit()), say("ok")]);
  assert.match(errorOf(second.results.at(-1)!)!, /^Add a regression test under test\/ that reproduces the failure\./);

  const third = await fx.run(conv, [
    callTools({ name: "write", args: { path: "test/green.test.ts", content: 'import { test } from "node:test";\ntest("passes everywhere", () => {});\n' } }, submit()),
    say("ok"),
  ]);
  assert.match(errorOf(third.results.at(-1)!)!, /^The regression test passes on main, so it does not reproduce the failure\./);

  const after = await current(incident.id);
  assert.equal(after.status, "fix_in_progress", "a failed proof does not move the timeline");
  assert.equal(after.report.commit, null);
  assert.equal(git(worktree, "rev-list", "--count", "main..HEAD"), "0");
});

test("submit_fix: proves the fix, commits on the incident branch, and moves to ready_for_review", async () => {
  const seen = fx.incidentChanges.length;
  const { incident, worktree } = await readyIncident();
  const head = git(worktree, "rev-parse", "--short", "HEAD");
  assert.equal(incident.report.commit, head);
  assert.equal(incident.report.rootCause, "loyaltyDiscount dereferenced customer.loyalty for guests.");
  assert.equal(incident.report.fix, "Return 0 when the customer has no loyalty data.");
  assert.equal(incident.summary, "Guests no longer crash checkout.");
  assert.match(incident.report.tests!, /^Regression test on main: tests 1, pass 0, fail 1/);
  assert.match(incident.report.tests!, /Full suite with the fix: tests \d+, pass \d+, fail 0/);
  assert.match(incident.report.diffStat!, /src\/pricing\/loyalty\.ts/);
  assert.match(incident.report.diffStat!, /test\/guest\.test\.ts/);
  assert.equal(incident.report.deployedRevision, null);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "fix(pricing): guests have no loyalty data");
  assert.equal(git(worktree, "rev-list", "--count", "main..HEAD"), "1");
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), incident.branch);
  assert.match(readFileSync(join(repo, "src/pricing/loyalty.ts"), "utf8"), /customer\.loyalty!\.tier/, "main still has the bug: nothing was merged");
  assert.deepEqual(incident.timeline.map((e) => e.status), ["starting", "investigating", "root_cause_found", "fix_in_progress", "ready_for_review"]);
  assert.equal(fx.incidentChanges.slice(seen).at(-1)!.incident.status, "ready_for_review");
  assert.equal(fx.incidentChanges.slice(seen).at(-1)!.announce, false, "the voice speaks at deploy, not at submit");
});

test("submit_fix: calling it again reuses the commit", async () => {
  const { incident, conv, worktree } = await readyIncident();
  const { results } = await fx.run(conv, [callTools(submit({ summary: "Same fix, resubmitted." })), say("ok")]);
  assert.equal(errorOf(results[0]), null);
  const after = await current(incident.id);
  assert.equal(after.status, "ready_for_review");
  assert.equal(after.report.commit, incident.report.commit);
  assert.equal(after.summary, "Same fix, resubmitted.");
  assert.equal(git(worktree, "rev-list", "--count", "main..HEAD"), "1");
});

// ── the git guard, inside a run ─────────────────────────────────────────────────────────────────────

test("the guard stops a blocked git command in a real run and lets a safe one through", async () => {
  const { conv, worktree } = await readyIncident();
  const { results } = await fx.run(conv, [
    callTools(
      { name: "bash", args: { command: "git push origin HEAD" } },
      { name: "bash", args: { command: "git checkout main" } },
      { name: "bash", args: { command: "git log --oneline -1" } },
      { name: "bash", args: { command: "git rev-parse --abbrev-ref HEAD" } },
    ),
    say("ok"),
  ]);
  assert.match(errorOf(results[0])!, /^Tool call blocked: Blocked by the incident guard\./);
  assert.match(errorOf(results[1])!, /Blocked by the incident guard/);
  assert.equal(results[2].isError, false);
  assert.match(results[2].text, /fix\(pricing\): guests have no loyalty data/);
  assert.match(results[3].text, /incident\/inc-/);
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").startsWith("incident/"), true, "still on the incident branch");
});

// ── deploy ──────────────────────────────────────────────────────────────────────────────────────────

test("deploy: nothing to deploy before submit_fix", async () => {
  const { conv } = await newIncident();
  const count = (await deploys()).length;
  const { results } = await fx.run(conv, [callTools({ name: "deploy", args: { summary: "ship it" } }, update("investigating"), { name: "deploy", args: { summary: "ship it" } }), say("ok")]);
  assert.equal(errorOf(results[0]), "Nothing to deploy yet. Run submit_fix first.");
  assert.equal(errorOf(results[2]), "Nothing to deploy yet. Run submit_fix first.");
  assert.equal((await deploys()).length, count, "no deploy request was created");
});

test("deploy: waits for the engineer, rolls out, verifies live checkouts, and marks the incident deployed", async () => {
  const { incident, conv } = await readyIncident();
  const before = await revisionsSoFar();
  const seen = fx.incidentChanges.length;
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "Ships the guest fix; the regression test covers it." } }), say("Deployed.")]);

  const request = await awaitDeploy(incident.id);
  assert.equal(request.commit, incident.report.commit);
  assert.equal(request.branch, incident.branch);
  assert.equal(request.summary, "Ships the guest fix; the regression test covers it.");
  assert.equal(request.diffStat, incident.report.diffStat);
  assert.equal(request.conversationId, incident.conversationId);
  assert.deepEqual([request.revision, request.decidedAt, request.note, request.verification], [null, null, null, null]);
  const announced = fx.incidentChanges.slice(seen).filter((c) => c.incident.id === incident.id && c.announce);
  assert.equal(announced.length, 1, "the engineer hears about it once, when the deploy first asks");
  assert.equal((await current(incident.id)).announced.ready, true);
  assert.ok(!store.control().deploy_request || JSON.parse(store.control().deploy_request).id !== request.id, "nothing is rolled out before approval");

  await decide(request.id, true);
  const rollout = await rollOut(request.id);
  const expectedRevision = `checkout-api-${String(43 + before).padStart(5, "0")}-${incident.report.commit!.slice(0, 3)}`;
  assert.deepEqual(rollout, { id: request.id, commit: incident.report.commit, revision: expectedRevision });

  const { results } = await turn.done();
  assert.equal(
    results[0].text,
    `Deployed ${incident.report.commit} as ${expectedRevision}. Verified on live traffic: 3 checkouts, 3 from guests, 0 errors.`,
  );
  const done = (await deploys()).find((d) => d.id === request.id)!;
  assert.equal(done.status, "deployed");
  assert.equal(done.revision, expectedRevision);
  assert.deepEqual(done.verification, { checkouts: 3, guests: 3, errors: 0 });
  assert.ok(done.decidedAt! >= done.requestedAt);

  const after = await current(incident.id);
  assert.equal(after.status, "deployed");
  assert.equal(after.report.deployedRevision, expectedRevision);
  assert.equal(after.summary, `${expectedRevision} is live: 3 checkouts, 3 from guests, 0 errors.`);
  assert.equal(after.timeline.at(-1)!.status, "deployed");
  assert.equal(fx.incidentChanges.at(-1)!.incident.status, "deployed", "the UI is told when the deploy lands");
});

test("deploy: calling it again once deployed reports the revision and asks nobody", async () => {
  const { incident, conv } = await readyIncident();
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("ok")]);
  const request = await awaitDeploy(incident.id);
  await decide(request.id, true);
  await rollOut(request.id);
  await turn.done();
  const count = (await deploys()).length;
  const { results } = await fx.run(conv, [callTools({ name: "deploy", args: { summary: "again" } }), say("ok")]);
  assert.match(results[0].text, /^Already deployed as checkout-api-000\d\d-\w{3}\.$/);
  assert.equal((await deploys()).length, count);
});

test("deploy: a declined deploy ships nothing, and asking again opens a fresh request that is not announced twice", async () => {
  const { incident, conv } = await readyIncident();
  const seen = fx.incidentChanges.length;
  const before = await revisionsSoFar();

  const first = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("Understood.")]);
  const declinedRequest = await awaitDeploy(incident.id);
  await decide(declinedRequest.id, false, "Hold until the morning");
  const declined = await first.done();
  assert.equal(
    declined.results[0].text,
    "The engineer declined the deploy: Hold until the morning. Nothing shipped. Wait for their direction and call deploy again only if they ask.",
  );
  const afterDecline = (await deploys()).find((d) => d.id === declinedRequest.id)!;
  assert.equal(afterDecline.status, "declined");
  assert.equal(afterDecline.note, "Hold until the morning");
  assert.equal(afterDecline.revision, null);
  assert.equal((await current(incident.id)).status, "ready_for_review", "the incident is still waiting");
  assert.ok(!store.control().deploy_request || JSON.parse(store.control().deploy_request).id !== declinedRequest.id, "no rollout was requested");

  // The engineer asks the agent to deploy after all.
  const second = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship, as asked" } }), say("Deployed.")]);
  const request = await awaitDeploy(incident.id, "awaiting_approval");
  assert.notEqual(request.id, declinedRequest.id);
  await decide(request.id, true);
  await rollOut(request.id);
  const { results } = await second.done();
  const expected = `checkout-api-${String(43 + before).padStart(5, "0")}-${incident.report.commit!.slice(0, 3)}`;
  assert.match(results[0].text, new RegExp(`^Deployed ${incident.report.commit} as ${expected}\\.`), "a declined deploy never took a revision number");
  assert.equal((await current(incident.id)).status, "deployed");
  const announced = fx.incidentChanges.slice(seen).filter((c) => c.incident.id === incident.id && c.announce);
  assert.equal(announced.length, 1, "one spoken announcement across both requests");
});

test("deploy: verification waits until three checkouts have been served on the new revision", async () => {
  const { incident, conv } = await readyIncident();
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("Live.")]);
  const request = await awaitDeploy(incident.id);
  await decide(request.id, true);
  let ack!: { id: number; commit: string; revision: string };
  await until(() => {
    const raw = store.control().deploy_request;
    if (raw) ack = JSON.parse(raw);
    return !!raw && ack.id === request.id;
  }, 10_000, "the rollout request");
  writeControl(logs, "deployed", JSON.stringify({ ...ack, at: Date.now() }));
  const checkout = () =>
    insertLog(
      logs,
      makeRow({ id: 0, revision: ack.revision, route: "/v1/checkout", entry: { jsonPayload: { message: "checkout", customer: { guest: true, region: "us-ca" } } } }),
    );
  checkout();
  await awaitDeploy(incident.id, "verifying");
  await delay(1000); // two verification polls with only one checkout seen
  assert.equal((await deploys()).find((d) => d.id === request.id)!.status, "verifying", "one checkout is not enough");
  checkout();
  checkout();
  const { results } = await turn.done();
  assert.match(results[0].text, /Deployed \w+ as checkout-api-000\d\d-\w{3}\. Verified on live traffic: 3 checkouts, 3 from guests, 0 errors\.$/);
  assert.equal((await current(incident.id)).status, "deployed");
});

test("deploy: a revision that fails verification is reported as failed and the incident is not marked deployed", async () => {
  const { incident, conv } = await readyIncident();
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("It failed.")]);
  const request = await awaitDeploy(incident.id);
  await decide(request.id, true);
  const rollout = await rollOut(request.id, 1);
  const { results } = await turn.done();
  assert.equal(results[0].isError, true);
  assert.match(results[0].text, /^Waiting for the engineer to approve the deploy\.\nApproved\. Rolling out a new checkout-api revision\.\n/, "each phase streams into the call's live output");
  assert.ok(results[0].text.endsWith(`[error] Deploy failed: ${rollout.revision} served 3 checkouts with 1 errors.\n</harness>`) || results[0].text.endsWith(`[error] Deploy failed: ${rollout.revision} served 3 checkouts with 1 errors.`), results[0].text);
  const failed = (await deploys()).find((d) => d.id === request.id)!;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.verification, { checkouts: 3, guests: 3, errors: 1 });
  const after = await current(incident.id);
  assert.equal(after.status, "ready_for_review");
  assert.equal(after.report.deployedRevision, null);
});

test("deploy: interrupting the call while it waits for approval cancels the deploy", async () => {
  const { incident, conv } = await readyIncident();
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("Stopped.")]);
  const request = await awaitDeploy(incident.id);
  await conv.abort(ctx);
  await turn.done().catch(() => {});
  await until(async () => (await deploys()).find((d) => d.id === request.id)?.status === "cancelled", 10_000, "the deploy to cancel");
  assert.equal((await current(incident.id)).status, "ready_for_review");
  assert.ok(!store.control().deploy_request || JSON.parse(store.control().deploy_request).id !== request.id);
});

test("deploy: interrupting after approval withdraws the rollout request before the stream picks it up", async () => {
  const { incident, conv } = await readyIncident();
  const turn = await fx.start(conv, [callTools({ name: "deploy", args: { summary: "ship" } }), say("Stopped.")]);
  const request = await awaitDeploy(incident.id);
  await decide(request.id, true);
  await until(() => !!store.control().deploy_request && JSON.parse(store.control().deploy_request).id === request.id, 10_000, "the rollout request");
  await conv.abort(ctx);
  await turn.done().catch(() => {});
  await until(async () => (await deploys()).find((d) => d.id === request.id)?.status === "cancelled", 10_000, "the deploy to cancel");
  assert.equal(store.control().deploy_request, undefined, "the pending request was withdrawn");
  assert.equal((await current(incident.id)).status, "ready_for_review", "nothing shipped");
});

test("deploy: a backend restart while waiting for approval resumes the same deploy, with no duplicate request", async () => {
  const { incident } = await readyIncident();
  const conversation = await fx.conversationOf(incident);
  const turn = await fx.start(conversation, [callTools({ name: "deploy", args: { summary: "ship" } })]);
  const request = await awaitDeploy(incident.id);
  const submissionId = turn.id;
  const count = (await deploys()).length;

  // "Kill" the backend and start it again over the same database.
  await fx.close();
  fx = await openFixture({ dir: t.root, repoDir: repo, store });
  fx.faux.setResponses([say("Deployed after the restart.")]);
  await until(async () => (await fx.harness.snapshot(Deploys, ctx))?.items[String(request.id)]?.status === "awaiting_approval", 10_000, "the deploy to be visible again");
  assert.equal((await deploys()).length, count, "the rerun tool found its request instead of making another");
  assert.equal((await current(incident.id)).announced.ready, true);

  await decide(request.id, true);
  await rollOut(request.id);
  const submission = await fx.harness.submission(submissionId as never, ctx);
  const record = await submission!.wait(ctx);
  assert.equal(record.status, "done");
  const results = await fx.toolResults(await fx.conversationOf(incident));
  assert.match(results.at(-1)!.text, /^Deployed \w+ as checkout-api-000\d\d-\w{3}\. Verified on live traffic: 3 checkouts, 3 from guests, 0 errors\.$/);
  assert.equal((await deploys()).length, count);
  assert.equal((await current(incident.id)).status, "deployed");
  assert.equal(fx.incidentChanges.filter((c) => c.announce).length, 0, "the restarted backend did not announce again");
});

test("the Ops desk lists the incidents it can see", async () => {
  const { results } = await fx.run(fx.root, [callTools({ name: "list_incidents", args: {} }), say("ok")]);
  const listed = JSON.parse(results[0].text) as Record<string, unknown>[];
  assert.ok(listed.length >= 5);
  assert.ok(listed.every((i) => !("timeline" in i)));
  assert.ok(listed.some((i) => i.status === "deployed"));
  assert.equal((await fx.harness.snapshot(Incidents, ctx))!.seq, seq);
});
