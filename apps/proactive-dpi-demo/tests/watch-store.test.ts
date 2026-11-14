import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { insertLog, makeRow, openLogDb, tempDir } from "./helpers.ts";
import { WatchStore } from "../apps/proactive-dpi-be/src/watch-store.ts";
import type { LogRow, Verdict } from "../shared/types.ts";

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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Insert into the log store (as the logs process would) and return the row with its real id. */
function add(over: Parameters<typeof makeRow>[0] = {}): LogRow {
  const row = makeRow({ id: 0, ...over });
  const id = insertLog(logs, row);
  return { ...row, id };
}

const verdict = (row: LogRow, over: Partial<Verdict> = {}): Verdict => ({
  logId: row.id,
  status: "judged",
  fingerprint: "checkout-api · POST /v1/checkout · TypeError",
  decision: "incident",
  probability: 0.93,
  probabilities: { normal: 0.02, suspicious: 0.05, incident: 0.93 },
  impact: 3,
  model: "jev-latest",
  latencyMs: 410,
  cost: 0.00003,
  judgedAt: Date.now(),
  ...over,
});

test("constructor: creates the verdicts table over the log store, and the log store when it is missing", () => {
  const fresh = tempDir();
  try {
    const s = new WatchStore(join(fresh.root, "w.sqlite"), join(fresh.root, "never-written.sqlite"));
    assert.equal(s.stats().rows, 0);
    assert.deepEqual(s.control(), {});
    s.close();
  } finally {
    fresh.cleanup();
  }
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes("verdicts"));
});

test("unjudgedAfter: rows past the cursor with no verdict, oldest first, limited", () => {
  const rows = [add(), add(), add(), add(), add()];
  store.saveVerdict(verdict(rows[1]), rows[1].ts);
  assert.deepEqual(store.unjudgedAfter(0, 10).map((r) => r.id), [rows[0].id, rows[2].id, rows[3].id, rows[4].id]);
  assert.deepEqual(store.unjudgedAfter(rows[2].id, 10).map((r) => r.id), [rows[3].id, rows[4].id]);
  assert.deepEqual(store.unjudgedAfter(0, 2).map((r) => r.id), [rows[0].id, rows[2].id]);
  assert.deepEqual(store.unjudgedAfter(rows[4].id, 10), []);
  const first = store.unjudgedAfter(0, 1)[0];
  assert.deepEqual(first.entry, rows[0].entry, "entries come back parsed");
});

test("an in-flight row (logged but never given a verdict) stays unjudged until a verdict is saved", () => {
  const a = add();
  const b = add();
  store.saveVerdict(verdict(b), b.ts); // b was judged first; a was in flight when the process died
  assert.equal(store.maxJudged(), b.id);
  assert.deepEqual(store.unjudgedAfter(0, 10).map((r) => r.id), [a.id]);
  store.saveVerdict(verdict(a), a.ts);
  assert.deepEqual(store.unjudgedAfter(0, 10), []);
});

test("maxJudged: 0 when empty, then the highest judged log id", () => {
  assert.equal(store.maxJudged(), 0);
  const [a, b] = [add(), add()];
  store.saveVerdict(verdict(a), a.ts);
  assert.equal(store.maxJudged(), a.id);
  store.saveVerdict(verdict(b, { status: "skipped", decision: undefined }), b.ts);
  assert.equal(store.maxJudged(), b.id, "skipped rows count as judged");
});

test("saveVerdict: every field survives a round trip through recent()", () => {
  const row = add();
  const v = verdict(row);
  store.saveVerdict(v, row.ts);
  const [out] = store.recent(5);
  assert.equal(out.id, row.id);
  assert.deepEqual(out.entry, row.entry);
  assert.deepEqual(out.verdict, { ...v, error: undefined });
});

test("saveVerdict: error and skipped verdicts keep their reason and leave the judgment fields undefined", () => {
  const [a, b] = [add(), add()];
  store.saveVerdict(
    { logId: a.id, status: "error", fingerprint: "fp", error: "Jev HTTP 503", judgedAt: 5 },
    a.ts,
  );
  store.saveVerdict(
    { logId: b.id, status: "skipped", fingerprint: "fp", error: "Older than the backlog window", judgedAt: 6 },
    b.ts,
  );
  const [ra, rb] = store.rows([a.id, b.id]);
  assert.deepEqual(ra.verdict, {
    logId: a.id,
    status: "error",
    fingerprint: "fp",
    decision: undefined,
    probability: undefined,
    probabilities: undefined,
    impact: undefined,
    model: undefined,
    latencyMs: undefined,
    cost: undefined,
    error: "Jev HTTP 503",
    judgedAt: 5,
  });
  assert.equal(rb.verdict?.status, "skipped");
  assert.equal(rb.verdict?.error, "Older than the backlog window");
});

test("saveVerdict: a second verdict for the same row replaces the first", () => {
  const row = add();
  store.saveVerdict({ logId: row.id, status: "error", fingerprint: "fp", error: "boom", judgedAt: 1 }, row.ts);
  store.saveVerdict(verdict(row, { fingerprint: "fp" }), row.ts);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM verdicts").get()?.n, 1);
  const [out] = store.rows([row.id]);
  assert.equal(out.verdict?.status, "judged");
  assert.equal(out.verdict?.error, undefined);
});

test("recent: the newest rows, oldest first, with and without verdicts", () => {
  const rows = [add(), add(), add(), add()];
  store.saveVerdict(verdict(rows[3]), rows[3].ts);
  const recent = store.recent(3);
  assert.deepEqual(recent.map((r) => r.id), [rows[1].id, rows[2].id, rows[3].id]);
  assert.equal(recent[0].verdict, undefined);
  assert.equal(recent[2].verdict?.decision, "incident");
  assert.deepEqual(store.recent(0), []);
});

test("rows: empty ids return nothing; ids come back in id order with their verdicts", () => {
  assert.deepEqual(store.rows([]), []);
  const [a, b, c] = [add(), add(), add()];
  store.saveVerdict(verdict(b), b.ts);
  const out = store.rows([c.id, a.id, b.id]);
  assert.deepEqual(out.map((r) => r.id), [a.id, b.id, c.id]);
  assert.equal(out[1].verdict?.decision, "incident");
  assert.equal(out[0].verdict, undefined);
  assert.deepEqual(store.rows([99999]), []);
});

test("hits: log ids for one fingerprint and decision inside the window, oldest first", () => {
  const fp = "checkout-api · POST /v1/checkout · TypeError";
  const old = add({ ts: minutesAgo(10) });
  const [a, b, c, d] = [add(), add(), add(), add()];
  store.saveVerdict(verdict(old, { fingerprint: fp }), old.ts);
  store.saveVerdict(verdict(a, { fingerprint: fp }), a.ts);
  store.saveVerdict(verdict(b, { fingerprint: fp, decision: "suspicious" }), b.ts);
  store.saveVerdict(verdict(c, { fingerprint: "other" }), c.ts);
  store.saveVerdict(verdict(d, { fingerprint: fp }), d.ts);
  assert.deepEqual(store.hits(fp, "incident", minutesAgo(5)), [a.id, d.id]);
  assert.deepEqual(store.hits(fp, "incident", minutesAgo(15)), [old.id, a.id, d.id]);
  assert.deepEqual(store.hits(fp, "suspicious", minutesAgo(5)), [b.id]);
  assert.deepEqual(store.hits(fp, "normal", minutesAgo(15)), []);
});

test("fingerprintCounts: only suspicious and incident verdicts, grouped, busiest first", () => {
  const rows = Array.from({ length: 7 }, () => add());
  const decisions: [number, string, Verdict["decision"]][] = [
    [0, "A", "incident"],
    [1, "A", "incident"],
    [2, "A", "incident"],
    [3, "B", "suspicious"],
    [4, "B", "suspicious"],
    [5, "A", "normal"],
    [6, "A", "suspicious"],
  ];
  for (const [i, fingerprint, decision] of decisions) store.saveVerdict(verdict(rows[i], { fingerprint, decision }), rows[i].ts);
  const counts = store.fingerprintCounts(minutesAgo(5));
  assert.deepEqual(
    counts.map((c) => [c.fingerprint, c.decision, c.count]),
    [
      ["A", "incident", 3],
      ["B", "suspicious", 2],
      ["A", "suspicious", 1],
    ],
  );
  assert.ok(counts[0].first <= counts[0].last);
  assert.equal(store.fingerprintCounts(minutesAgo(-1)).length, 0, "nothing since the future");
});

test("query: defaults to the last 30 minutes, newest first", () => {
  const old = add({ ts: minutesAgo(45) });
  const recent = add({ ts: minutesAgo(5) });
  const newest = add({ ts: minutesAgo(1) });
  assert.deepEqual(store.query({}).map((r) => r.id), [newest.id, recent.id]);
  assert.deepEqual(store.query({ sinceMinutes: 60 }).map((r) => r.id), [newest.id, recent.id, old.id]);
});

test("query: filters by service, route, status, revision, decision and text", () => {
  const a = add({ service: "cart-api", route: "/v1/cart/items", status: 201, revision: "cart-1", message: "added sku=lamp-01" });
  const b = add({ service: "checkout-api", route: "/v1/checkout", status: 500, revision: "co-2", message: "Unhandled exception" });
  const c = add({ service: "checkout-api", route: "/v1/checkout", status: 200, revision: "co-1", message: "checkout completed" });
  store.saveVerdict(verdict(b), b.ts);
  const ids = (q: Parameters<WatchStore["query"]>[0]) => store.query(q).map((r) => r.id);
  assert.deepEqual(ids({ service: "checkout-api" }), [c.id, b.id]);
  assert.deepEqual(ids({ route: "/v1/cart/items" }), [a.id]);
  assert.deepEqual(ids({ status: 500 }), [b.id]);
  assert.deepEqual(ids({ revision: "co-1" }), [c.id]);
  assert.deepEqual(ids({ decision: "incident" }), [b.id]);
  assert.deepEqual(ids({ decision: "normal" }), []);
  assert.deepEqual(ids({ text: "sku=lamp" }), [a.id]);
  assert.deepEqual(ids({ text: "unhandled" }), [b.id], "text search is case insensitive");
  assert.deepEqual(ids({ service: "checkout-api", status: 200 }), [c.id], "filters combine with AND");
});

test("query: min severity includes that level and everything above it", () => {
  const rows = (["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"] as const).map((severity) => add({ severity }));
  const sev = (severity: string) => store.query({ severity }).map((r) => r.severity);
  assert.deepEqual(sev("WARNING"), ["CRITICAL", "ERROR", "WARNING"]);
  assert.deepEqual(sev("ERROR"), ["CRITICAL", "ERROR"]);
  assert.equal(sev("DEBUG").length, rows.length);
  assert.equal(sev("NOT-A-LEVEL").length, rows.length, "an unknown level asks for everything");
});

test("query: limit defaults to 30 and is capped at 100", () => {
  for (let i = 0; i < 120; i++) add();
  assert.equal(store.query({}).length, 30);
  assert.equal(store.query({ limit: 5 }).length, 5);
  assert.equal(store.query({ limit: 1000 }).length, 100);
});

test("summary: per-minute counts, per-revision traffic, deploy notices, and flagged fingerprints", () => {
  const ok = add({ revision: "r1", status: 200 });
  const err1 = add({ revision: "r2", status: 500, severity: "ERROR" });
  const err2 = add({ revision: "r2", status: 500, severity: "ERROR" });
  const other = add({ service: "catalog-api", revision: "c1", status: 200 });
  const notice = add({ severity: "NOTICE", method: null, route: null, status: null, latencyMs: null, message: "Deploying revision r2" });
  store.saveVerdict(verdict(err1), err1.ts);
  store.saveVerdict(verdict(err2, { decision: "suspicious" }), err2.ts);
  store.saveVerdict(verdict(ok, { decision: "normal" }), ok.ts);

  const s = store.summary(15);
  assert.ok(s.since <= new Date().toISOString());
  const minute = s.minutes[0] as Record<string, number>;
  assert.equal(minute.rows, 5);
  assert.equal(minute.errors, 2);
  assert.equal(minute.http5xx, 2);
  assert.equal(minute.incident, 1);
  assert.equal(minute.suspicious, 1);

  const revisions = s.revisions as { service: string; revision: string; rows: number; http5xx: number }[];
  const r2 = revisions.find((r) => r.revision === "r2")!;
  assert.deepEqual([r2.service, r2.rows, r2.http5xx], ["checkout-api", 2, 2]);
  assert.equal(revisions.find((r) => r.revision === "r1")!.http5xx, 0);
  assert.ok(revisions.some((r) => r.service === "catalog-api"));

  assert.deepEqual(s.deploys.map((d) => d.id), [notice.id]);
  assert.deepEqual(s.fingerprints.map((f) => [f.decision, f.count]).sort(), [["incident", 1], ["suspicious", 1]]);

  const onlyCatalog = store.summary(15, "catalog-api");
  assert.deepEqual((onlyCatalog.revisions as { revision: string }[]).map((r) => r.revision), ["c1"]);
  assert.equal((onlyCatalog.minutes[0] as { rows: number }).rows, 1);
  assert.deepEqual(onlyCatalog.deploys, [], "the notice belongs to checkout-api");
  assert.ok(other.id);
});

test("summary: rows older than the window are left out", () => {
  add({ ts: minutesAgo(40) });
  const s = store.summary(15);
  assert.deepEqual(s.minutes, []);
  assert.deepEqual(s.revisions, []);
});

test("stats: zeros on an empty store, then counts by decision and status with spend and latency", () => {
  assert.deepEqual(store.stats(), {
    rows: 0, judged: 0, normal: 0, suspicious: 0, incident: 0, errors: 0, skipped: 0, spend: 0, latencyMs: 0,
  });
  const rows = Array.from({ length: 6 }, () => add());
  store.saveVerdict(verdict(rows[0], { decision: "normal", cost: 0.1, latencyMs: 100 }), rows[0].ts);
  store.saveVerdict(verdict(rows[1], { decision: "suspicious", cost: 0.2, latencyMs: 200 }), rows[1].ts);
  store.saveVerdict(verdict(rows[2], { decision: "incident", cost: 0.3, latencyMs: 301 }), rows[2].ts);
  store.saveVerdict({ logId: rows[3].id, status: "error", fingerprint: "f", error: "x", judgedAt: 1 }, rows[3].ts);
  store.saveVerdict({ logId: rows[4].id, status: "skipped", fingerprint: "f", judgedAt: 1 }, rows[4].ts);
  const s = store.stats();
  assert.equal(s.rows, 6);
  assert.equal(s.judged, 5, "judged counts every stored verdict, skipped and errors included");
  assert.deepEqual([s.normal, s.suspicious, s.incident, s.errors, s.skipped], [1, 1, 1, 1, 1]);
  assert.ok(Math.abs(s.spend - 0.6) < 1e-9);
  assert.equal(s.latencyMs, 200, "average of the rows that have a latency, rounded");
});

test("deploy handshake: requests, cancels and acknowledgments travel through the shared control table", () => {
  assert.equal(store.deployed(), undefined);
  store.requestDeploy({ id: 7, commit: "abc1234", revision: "checkout-api-00043-abc" });
  store.requestDeploy({ id: 7, commit: "abc1234", revision: "checkout-api-00043-abc" }); // rewriting is harmless
  assert.deepEqual(JSON.parse(store.control().deploy_request), { id: 7, commit: "abc1234", revision: "checkout-api-00043-abc" });

  store.cancelDeploy(8); // someone else's id
  assert.ok(store.control().deploy_request, "a cancel for a different deploy leaves the request");
  store.cancelDeploy(7);
  assert.equal(store.control().deploy_request, undefined);
  store.cancelDeploy(7); // nothing to cancel

  // The logs process writes its acknowledgment into the same table.
  logs.prepare("INSERT INTO control(key, value) VALUES('deployed', ?)").run(
    JSON.stringify({ id: 7, commit: "abc1234", revision: "checkout-api-00043-abc", at: 99 }),
  );
  assert.deepEqual(store.deployed(), { id: 7, commit: "abc1234", revision: "checkout-api-00043-abc", at: 99 });
});

test("requestBugDeploy: leaves a timestamp the logs process picks up", () => {
  const before = Date.now();
  store.requestBugDeploy();
  const stamp = Number(store.control().inject_request);
  assert.ok(stamp >= before && stamp <= Date.now());
  assert.equal(Number(logs.prepare("SELECT value FROM control WHERE key='inject_request'").get()?.value), stamp);
});

test("checkoutStats: checkouts, guest checkouts and 5xx for one revision's checkout route only", () => {
  const guestRow = (revision: string, status: number) =>
    add({
      revision,
      status,
      severity: status >= 500 ? "ERROR" : "INFO",
      entry: { jsonPayload: { message: "m", customer: { guest: true, region: "us-ca" } } },
    });
  const memberRow = (revision: string, status: number) =>
    add({ revision, status, entry: { jsonPayload: { message: "m", customer: { guest: false, region: "us-ca" } } } });
  guestRow("rev-b", 200);
  guestRow("rev-b", 200);
  guestRow("rev-b", 500);
  memberRow("rev-b", 200);
  memberRow("rev-a", 200);
  add({ revision: "rev-b", route: "/v1/products", status: 500 }); // another route does not count
  assert.deepEqual(store.checkoutStats("rev-b"), { checkouts: 4, guests: 3, errors: 1 });
  assert.deepEqual(store.checkoutStats("rev-a"), { checkouts: 1, guests: 0, errors: 0 });
  assert.deepEqual(store.checkoutStats("rev-none"), { checkouts: 0, guests: 0, errors: 0 });
});
