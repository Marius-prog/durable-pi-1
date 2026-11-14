import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { makeCheckoutRepo, tempDir } from "./helpers.ts";
import { loadRevision, type Revision } from "../apps/proactive-dpi-logs/src/deploys.ts";
import { deployEvents, guestCheckout, nextEvent, type Generated } from "../apps/proactive-dpi-logs/src/traffic.ts";
import type { Severity } from "../shared/types.ts";

const t = tempDir();
let good: Revision;
let bad: Revision;

before(async () => {
  const repoDir = makeCheckoutRepo(t.root);
  const where = { repoDir, dataDir: `${t.root}/data` };
  good = await loadRevision("HEAD~1", "checkout-api-00041-rup", where);
  bad = await loadRevision("HEAD", "checkout-api-00042-vex", where);
});
after(() => t.cleanup());

/** Math.random that serves `first` queued values, then a small deterministic generator. */
function seededRandom() {
  let state = 12345;
  const queue: number[] = [];
  const rng = () => {
    if (queue.length) return queue.shift()!;
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return { rng, queue };
}

const SERVICES = new Set(["checkout-api", "catalog-api", "cart-api", "auth-api", "payments-webhook"]);
const SEVERITIES = new Set<Severity>(["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"]);

/** One event for every point of the weighted scenario table, so every scenario runs. */
async function sweep(revision: Revision, steps = 800) {
  const { rng, queue } = seededRandom();
  const random = mock.method(Math, "random", rng);
  try {
    const events: Generated[] = [];
    for (let i = 0; i < steps; i++) {
      queue.push((i + 0.5) / steps);
      events.push(await nextEvent(revision));
    }
    return events;
  } finally {
    random.mock.restore();
  }
}

test("nextEvent: every event is a well-formed Cloud Run LogEntry mirrored by its row fields", async () => {
  const events = await sweep(good);
  const ids = new Set<string>();
  for (const e of events) {
    const { entry } = e;
    assert.ok(!ids.has(entry.insertId), "insertId is unique");
    ids.add(entry.insertId);
    assert.match(entry.insertId, /^[0-9a-f]{24}$/);
    assert.ok(SEVERITIES.has(entry.severity));
    assert.ok(SERVICES.has(e.service), e.service);
    assert.equal(entry.resource.type, "cloud_run_revision");
    assert.equal(entry.resource.labels.service_name, e.service);
    assert.equal(entry.resource.labels.revision_name, e.revision);
    assert.equal(entry.resource.labels.project_id, "lumen-market-prod");
    assert.equal(entry.jsonPayload?.message, e.message);
    assert.ok(e.message.length > 0);
    assert.ok(Date.parse(entry.receiveTimestamp) >= Date.parse(entry.timestamp), "received after written");
    assert.match(entry.trace ?? "", /^projects\/lumen-market-prod\/traces\/[0-9a-f]{32}$/);
    assert.match(entry.logName, /^projects\/lumen-market-prod\/logs\/run\.googleapis\.com%2F(requests|stdout|stderr|varlog%2Fsystem)$/);
    if (e.method === null) {
      assert.equal(e.route, null);
      assert.equal(e.status, null);
      assert.equal(e.latencyMs, null);
      assert.equal(entry.httpRequest, undefined);
    } else {
      assert.ok(e.route && e.status && e.latencyMs !== null);
      assert.equal(entry.httpRequest?.status, e.status);
      assert.equal(entry.httpRequest?.requestMethod, e.method);
      assert.match(entry.httpRequest!.latency, /^\d+\.\d{6}s$/);
      assert.match(entry.httpRequest!.remoteIp, /^\d+\.\d+\.\d+\.\d+$/);
    }
  }
});

test("nextEvent: a healthy revision produces no 5xx, no ERROR rows and no error types", async () => {
  const events = await sweep(good);
  for (const e of events) {
    assert.ok(e.status === null || e.status < 500, `${e.message} -> ${e.status}`);
    assert.notEqual(e.entry.severity, "ERROR");
    assert.equal(e.errorType, null);
  }
});

test("nextEvent: the scenario table covers every service, status family and stream", async () => {
  const events = await sweep(good);
  assert.deepEqual(new Set(events.map((e) => e.service)), SERVICES);
  const statuses = new Set(events.map((e) => e.status));
  for (const status of [200, 201, 204, 401, 402, 404, 429]) assert.ok(statuses.has(status), `status ${status}`);
  const severities = new Set(events.map((e) => e.entry.severity));
  for (const severity of ["DEBUG", "INFO", "WARNING"] as const) assert.ok(severities.has(severity), severity);
  assert.ok(events.some((e) => e.message.startsWith("slow query")), "routine slow-query warnings stay in");
  assert.ok(events.some((e) => e.message.startsWith("inventory-service timeout")), "recovered upstream retries stay in");
  assert.ok(events.some((e) => e.message.startsWith("rate limited client=scraper-bot")), "scraper 429s stay in");
});

test("nextEvent: severity follows status (5xx ERROR, 429 WARNING, others INFO)", async () => {
  const events = await sweep(good);
  for (const e of events.filter((x) => x.entry.logName.endsWith("%2Frequests") && x.service !== "checkout-api")) {
    const expected = e.status! >= 500 ? "ERROR" : e.status === 429 ? "WARNING" : "INFO";
    assert.equal(e.entry.severity, expected, `${e.status} ${e.message}`);
  }
});

test("nextEvent: weights make traffic mostly routine, with checkout the busiest write path", async () => {
  const events = await sweep(good, 2000);
  const checkouts = events.filter((e) => e.route === "/v1/checkout");
  // Weights 9 + 6 + 1.5 of 68.1 total, about 24%.
  const share = checkouts.length / events.length;
  assert.ok(share > 0.2 && share < 0.28, `checkout share ${share}`);
  assert.ok(checkouts.every((e) => e.service === "checkout-api"));
  assert.ok(events.filter((e) => e.entry.severity === "WARNING" || e.entry.severity === "ERROR").length / events.length < 0.05);
});

test("nextEvent: a roll at the very top of the range still returns an event", async () => {
  const { rng, queue } = seededRandom();
  const random = mock.method(Math, "random", rng);
  try {
    queue.push(1); // roll = TOTAL_WEIGHT: the last scenario, or the fallback if rounding leaves a remainder
    const event = await nextEvent(good);
    assert.ok(event.entry.insertId);
  } finally {
    random.mock.restore();
  }
});

test("guestCheckout on the good revision succeeds as a guest", async () => {
  const event = await guestCheckout(good);
  assert.equal(event.status, 200);
  assert.equal(event.entry.severity, "INFO");
  assert.equal(event.revision, good.name);
  assert.equal(event.entry.labels?.commit_sha, good.commit);
  assert.match(event.message, /^checkout completed order=ord_\w+ total=\$\d+\.\d{2} items=\d customer=guest$/);
  assert.equal((event.entry.jsonPayload?.customer as { guest: boolean }).guest, true);
});

test("guestCheckout on the bad revision logs the real TypeError the way Cloud Run would", async () => {
  const event = await guestCheckout(bad);
  assert.equal(event.status, 500);
  assert.equal(event.entry.severity, "ERROR");
  assert.equal(event.errorType, "TypeError");
  assert.equal(event.message, "Unhandled exception in checkout handler");
  assert.equal(event.route, "/v1/checkout");
  assert.equal(event.revision, bad.name);
  assert.ok(event.latencyMs! >= 8 && event.latencyMs! <= 40, "failures return fast");
  assert.ok(event.entry.logName.endsWith("%2Fstderr"));
  const payload = event.entry.jsonPayload as unknown as { error: { type: string; message: string }; stack_trace: string };
  assert.equal(payload.error.type, "TypeError");
  assert.match(payload.stack_trace, /^TypeError: /);
  assert.match(payload.stack_trace, /file:\/\/\/workspace\/src\/pricing\/loyalty\.ts/);
  assert.ok(!payload.stack_trace.includes(t.root), "no host paths in the stack trace");
});

test("member checkouts on the bad revision still succeed: only guests are hit", async () => {
  const { rng, queue } = seededRandom();
  const random = mock.method(Math, "random", rng);
  try {
    const seen = { member: 0, guest: 0, decline: 0 };
    for (let i = 0; i < 40; i++) {
      queue.push(0.001); // first scenario: a member checkout
      const e = await nextEvent(bad);
      assert.equal(e.status === 200 || e.status === 402, true, `${e.status} ${e.message}`);
      if (e.message.startsWith("checkout completed")) seen.member++;
    }
    assert.equal(seen.member > 0, true);
    // The guest scenario starts after the member weight (9) of 68.1.
    queue.push((9 + 1) / 68.1);
    const guest = await nextEvent(bad);
    assert.equal(guest.status, 500);
  } finally {
    random.mock.restore();
  }
});

test("deployEvents: two NOTICE rows, the first from the old revision, the second from the new one", () => {
  const [announce, ready] = deployEvents(good, bad);
  assert.equal(announce.service, "checkout-api");
  assert.equal(announce.entry.severity, "NOTICE");
  assert.equal(announce.revision, good.name);
  assert.equal(announce.message, `Deploying revision ${bad.name} (commit ${bad.commit} "${bad.subject}")`);
  assert.deepEqual(announce.entry.jsonPayload?.deploy, { from: good.name, to: bad.name, commit: bad.commit });
  assert.equal(ready.entry.severity, "NOTICE");
  assert.equal(ready.revision, bad.name);
  assert.equal(ready.message, `Revision ${bad.name} is ready. Routing 100% of traffic.`);
  assert.equal(ready.entry.labels?.commit_sha, bad.commit);
  for (const row of [announce, ready]) {
    assert.equal(row.method, null);
    assert.equal(row.status, null);
    assert.ok(row.entry.logName.endsWith("%2Fvarlog%2Fsystem"));
  }
});
