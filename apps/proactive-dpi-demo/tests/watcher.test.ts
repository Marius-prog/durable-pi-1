import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { delay, insertLog, makeRow, openLogDb, tempDir, until } from "./helpers.ts";
import type { Jev, JevResult, Question } from "../apps/proactive-dpi-be/src/jev.ts";
import { QUESTIONS, Watcher, fingerprint, type Trigger } from "../apps/proactive-dpi-be/src/watcher.ts";
import { WatchStore } from "../apps/proactive-dpi-be/src/watch-store.ts";
import type { Decision, LogRow, Verdict } from "../shared/types.ts";

// ── fingerprints ────────────────────────────────────────────────────────────────────────────────────

test("fingerprint: service, method and route, then the error type", () => {
  const row = makeRow({ status: 500, errorType: "TypeError", severity: "ERROR" });
  assert.equal(fingerprint(row), "checkout-api · POST /v1/checkout · TypeError");
});

test("fingerprint: without an error type a 4xx or 5xx groups by HTTP status", () => {
  const status = (n: number, route = "/v1/products/:sku") =>
    fingerprint(makeRow({ service: "catalog-api", method: "GET", route, status: n, message: `product not found sku=lamp-${n}` }));
  assert.equal(status(404), "catalog-api · GET /v1/products/:sku · HTTP 404");
  assert.equal(status(503), "catalog-api · GET /v1/products/:sku · HTTP 503");
  assert.equal(status(404), status(404), "stable");
  assert.notEqual(status(404), status(503));
});

test("fingerprint: an error type wins over the status", () => {
  const row = makeRow({ status: 500, errorType: "RangeError" });
  assert.ok(fingerprint(row).endsWith(" · RangeError"));
});

test("fingerprint: healthy rows group by the shape of their message, with identifiers and numbers masked", () => {
  const a = makeRow({ message: "checkout completed order=ord_ab12cd total=$45.00 items=2 customer=guest" });
  const b = makeRow({ message: "checkout completed order=ord_zz99yy total=$1280.50 items=1 customer=guest" });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), "checkout-api · POST /v1/checkout · checkout completed order=* total=$#.# items=# customer=guest");
  const keyed = fingerprint(makeRow({ method: null, route: null, status: null, message: "added sku=lamp-01 qty=3 cart=cart_a1b2c3" }));
  assert.equal(keyed, "checkout-api · added sku=* qty=# cart=*");
});

test("fingerprint: masks each identifier key (sku, order, user, cart, key, client, category)", () => {
  const message = "x sku=a order=b user=c cart=d key=e client=f category=g y=keep";
  const fp = fingerprint(makeRow({ method: null, route: null, status: null, message }));
  assert.equal(fp, "checkout-api · x sku=* order=* user=* cart=* key=* client=* category=* y=keep");
});

test("fingerprint: long messages are cut to 64 characters", () => {
  const fp = fingerprint(makeRow({ method: null, route: null, status: null, message: "a".repeat(200) }));
  assert.equal(fp, `checkout-api · ${"a".repeat(64)}`);
});

test("fingerprint: rows with no HTTP request skip the route part", () => {
  const fp = fingerprint(makeRow({ service: "cart-api", method: null, route: null, status: null, message: "inventory-service timeout after 2000ms" }));
  assert.equal(fp, "cart-api · inventory-service timeout after #ms");
});

test("fingerprint: different services never share one", () => {
  const a = fingerprint(makeRow({ service: "a-api", status: 500, errorType: "TypeError" }));
  const b = fingerprint(makeRow({ service: "b-api", status: 500, errorType: "TypeError" }));
  assert.notEqual(a, b);
});

test("QUESTIONS: a three-way choice and a 0-4 impact score", () => {
  assert.equal(QUESTIONS.verdict.type, "choice");
  assert.deepEqual(Object.keys((QUESTIONS.verdict as { criteria: object }).criteria), ["normal", "suspicious", "incident"]);
  assert.equal(QUESTIONS.impact.type, "score");
  assert.equal((QUESTIONS.impact as { criteria: string[] }).criteria.length, 5);
});

// ── the watcher ─────────────────────────────────────────────────────────────────────────────────────

type Plan = {
  decision?: Decision;
  probability?: number;
  impact?: number;
  cost?: number | null;
  error?: unknown;
  /** Holds the answer until released. */
  hold?: Promise<void>;
};

/** A stand-in for the Jev client. `plan` decides each answer from the state it was shown. */
function fakeJev(plan: (state: Record<string, unknown>, call: number) => Plan = () => ({})) {
  const asked: { state: Record<string, unknown>; questions: Record<string, Question> }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const jev = {
    async ask(state: Record<string, unknown>, questions: Record<string, Question>): Promise<JevResult> {
      asked.push({ state, questions });
      const p = plan(state, asked.length);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (p.hold) await p.hold;
        if (p.error !== undefined) throw p.error;
        const decision = p.decision ?? "normal";
        const probability = p.probability ?? 0.95;
        const rest = (1 - probability) / 2;
        const probabilities = Object.fromEntries(
          (["normal", "suspicious", "incident"] as const).map((d) => [d, d === decision ? probability : rest]),
        );
        return {
          model: "fake-jev",
          cost: p.cost === undefined ? 0.00003 : p.cost,
          latencyMs: 12,
          answers: {
            verdict: { type: "choice", choice: decision, probabilities, confidence: 0.9 },
            impact: { type: "score", score: p.impact ?? 0, probabilities: {}, confidence: 0.9 },
          },
        };
      } finally {
        inFlight--;
      }
    },
  };
  return { jev: jev as unknown as Jev, asked, maxInFlight: () => maxInFlight };
}

let t: ReturnType<typeof tempDir>;
let logs: DatabaseSync;
let store: WatchStore;
let watchers: Watcher[];
let errors: ReturnType<typeof mock.method>;

beforeEach(() => {
  t = tempDir();
  logs = openLogDb(t.root);
  store = new WatchStore(join(t.root, "watch.sqlite"), join(t.root, "logs.sqlite"));
  watchers = [];
  errors = mock.method(console, "error", () => {});
});
afterEach(() => {
  for (const w of watchers) w.stop();
  errors.mock.restore();
  store.close();
  logs.close();
  t.cleanup();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function add(over: Parameters<typeof makeRow>[0] = {}): LogRow {
  const row = makeRow({ id: 0, ...over });
  return { ...row, id: insertLog(logs, row) };
}

const BAD = { status: 500, severity: "ERROR" as const, errorType: "TypeError", message: "bad" };

function watch(
  jev: Jev,
  onTrigger: (trigger: Trigger) => Promise<void> = async () => {},
  options: Partial<ConstructorParameters<typeof Watcher>[2]> = {},
) {
  const watcher = new Watcher(
    store,
    jev,
    { concurrency: 6, incidentThreshold: 3, suspiciousThreshold: 8, windowMs: 120_000, backlogMs: 300_000, ...options },
    onTrigger,
  );
  watchers.push(watcher);
  const verdicts: Verdict[] = [];
  const seen: LogRow[] = [];
  watcher.on("verdict", (v: Verdict) => verdicts.push(v));
  watcher.on("log", (r: LogRow) => seen.push(r));
  return { watcher, verdicts, seen };
}

test("judging: stores Jev's decision, its probability, the impact score, model, latency and cost", async () => {
  const row = add(BAD);
  const { jev, asked } = fakeJev(() => ({ decision: "incident", probability: 0.9, impact: 3, cost: 0.0002 }));
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  await until(() => verdicts.length === 1);
  const [stored] = store.rows([row.id]);
  assert.equal(stored.verdict?.status, "judged");
  assert.equal(stored.verdict?.decision, "incident");
  assert.equal(stored.verdict?.probability, 0.9);
  assert.equal(stored.verdict?.impact, 3);
  assert.equal(stored.verdict?.model, "fake-jev");
  assert.equal(stored.verdict?.latencyMs, 12);
  assert.equal(stored.verdict?.cost, 0.0002);
  assert.equal(stored.verdict?.fingerprint, "checkout-api · POST /v1/checkout · TypeError");
  assert.deepEqual(Object.keys(stored.verdict!.probabilities!).sort(), ["incident", "normal", "suspicious"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].questions, QUESTIONS, "Jev is asked the watcher's questions");
  assert.deepEqual({ ...verdicts[0], error: undefined }, stored.verdict, "the emitted verdict is the stored one");
});

test("judging: a null cost is stored as no cost", async () => {
  const row = add();
  const { watcher, verdicts } = watch(fakeJev(() => ({ cost: null })).jev);
  watcher.start();
  await until(() => verdicts.length === 1);
  assert.equal(store.rows([row.id])[0].verdict?.cost, undefined);
});

test("judging: Jev sees the entry without IDs, traces or the raw stack, and at most 3 stack lines", async () => {
  const stack = ["TypeError: Cannot read properties of undefined (reading 'tier')", "    at loyaltyDiscount (file:///workspace/src/pricing/loyalty.ts:12:40)", "    at priceCart (file:///workspace/src/pricing/cart.ts:14:27)", "    at handleCheckout (file:///workspace/src/routes/checkout.ts:14:18)", "    at Server (file:///workspace/src/server.ts:12:30)"].join("\n");
  add({
    ...BAD,
    latencyMs: 17,
    entry: { jsonPayload: { message: "bad", stack_trace: stack, customer: { guest: true, region: "us-ca" }, error: { type: "TypeError" } } },
  });
  const { jev, asked } = fakeJev();
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  await until(() => verdicts.length === 1);
  const state = asked[0].state;
  assert.equal(state.severity, "ERROR");
  assert.equal(state.service, "checkout-api");
  assert.equal(state.revision, "checkout-api-00041-rup");
  assert.equal(state.request, "POST /v1/checkout → 500 in 17ms");
  assert.equal(state.message, "bad");
  assert.equal(state.stack_trace, stack.split("\n").slice(0, 3).join("\n"));
  assert.deepEqual(state.customer, { guest: true, region: "us-ca" });
  assert.deepEqual(state.error, { type: "TypeError" });
  for (const noise of ["insertId", "trace", "spanId", "logName", "resource", "timestamp", "id", "ts"])
    assert.ok(!(noise in state), `${noise} is not shown to Jev`);
  assert.ok(JSON.stringify(state).includes("loyalty.ts:12:40"));
  assert.ok(!JSON.stringify(state).includes("server.ts"), "the fourth frame is cut");
});

test("judging: rows without a request or payload are described from their message", async () => {
  const entryless = makeRow({ id: 0, method: null, route: null, status: null, latencyMs: null, message: "Container instance started in 410ms" });
  delete (entryless.entry as { jsonPayload?: unknown }).jsonPayload;
  insertLog(logs, entryless);
  const { jev, asked } = fakeJev();
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  await until(() => verdicts.length === 1);
  assert.equal(asked[0].state.request, undefined);
  assert.equal(asked[0].state.message, "Container instance started in 410ms");
  assert.equal(asked[0].state.stack_trace, undefined);
});

test("judging: a Jev failure is stored as an error verdict with its message, and opens nothing", async () => {
  const rows = [add(BAD), add(BAD), add(BAD), add({ message: "fine" })];
  const triggers: Trigger[] = [];
  const failures = [Error("Jev HTTP 503"), "plain string failure", Error("Jev HTTP 429")];
  const { jev } = fakeJev((_s, call) => (call <= 3 ? { error: failures[call - 1] } : {}));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  watcher.start();
  await until(() => verdicts.length === 4);
  const stored = store.rows(rows.map((r) => r.id));
  assert.deepEqual(stored.map((r) => r.verdict!.status), ["error", "error", "error", "judged"]);
  assert.deepEqual(stored.slice(0, 3).map((r) => r.verdict!.error), ["Jev HTTP 503", "plain string failure", "Jev HTTP 429"]);
  assert.equal(stored[0].verdict!.decision, undefined);
  assert.equal(stored[0].verdict!.fingerprint, "checkout-api · POST /v1/checkout · TypeError", "errors keep their fingerprint");
  assert.equal(triggers.length, 0, "three failing rows with the same fingerprint, but no verdicts to count");
  assert.equal(store.stats().errors, 3);
});

test("backlog: rows older than the backlog window are skipped and never sent to Jev", async () => {
  const old = add({ ts: minutesAgo(10), message: "old" });
  const fresh = add({ message: "fresh" });
  const { jev, asked } = fakeJev();
  const { watcher, verdicts, seen } = watch(jev, undefined, { backlogMs: 5 * 60_000 });
  watcher.start();
  await until(() => verdicts.length === 2);
  const [a, b] = store.rows([old.id, fresh.id]);
  assert.equal(a.verdict?.status, "skipped");
  assert.equal(a.verdict?.error, "Older than the backlog window");
  assert.equal(a.verdict?.decision, undefined);
  assert.equal(b.verdict?.status, "judged");
  assert.deepEqual(asked.map((q) => q.state.message), ["fresh"]);
  assert.deepEqual(seen.map((r) => r.id), [old.id, fresh.id], "skipped rows still reach the live stream");
  assert.equal(store.stats().skipped, 1);
});

test("restart: rows left in flight below the newest verdict are judged again; judged rows are not", async () => {
  const rows = [add({ message: "one" }), add({ message: "two" }), add({ message: "three" })];
  // The previous run judged the newest row, then died with the other two in flight.
  store.saveVerdict({ logId: rows[2].id, status: "judged", fingerprint: "fp", decision: "normal", judgedAt: 1 }, rows[2].ts);
  const { jev, asked } = fakeJev();
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  await until(() => verdicts.length === 2);
  assert.deepEqual(asked.map((q) => q.state.message).sort(), ["one", "two"]);
  assert.equal(store.unjudgedAfter(0, 10).length, 0);
});

test("restart: only the 500 ids below the newest verdict are re-scanned", async () => {
  const first = add({ message: "stranded" });
  for (let i = 0; i < 600; i++) {
    const row = add();
    store.saveVerdict({ logId: row.id, status: "judged", fingerprint: "fp", decision: "normal", judgedAt: 1 }, row.ts);
  }
  const { jev, asked } = fakeJev();
  const { watcher, seen } = watch(jev);
  watcher.start();
  await delay(700); // two polls
  assert.equal(asked.length, 0, "nothing re-judged");
  assert.equal(seen.length, 0);
  assert.equal(store.rows([first.id])[0].verdict, undefined, "the stranded row is out of reach");
});

test("polling: picks up rows written after start, and large backlogs over several polls", async () => {
  const { jev } = fakeJev();
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  const late = add({ message: "late" });
  await until(() => verdicts.length === 1, 3000);
  assert.equal(verdicts[0].logId, late.id);
  for (let i = 0; i < 250; i++) add();
  await until(() => verdicts.length === 251, 5000);
  assert.equal(store.unjudgedAfter(0, 1000).length, 0);
});

test("polling: rows are judged oldest first when one call runs at a time", async () => {
  const rows = [add({ message: "a" }), add({ message: "b" }), add({ message: "c" })];
  const { jev, asked } = fakeJev();
  const { watcher, verdicts } = watch(jev, undefined, { concurrency: 1 });
  watcher.start();
  await until(() => verdicts.length === 3);
  assert.deepEqual(asked.map((q) => q.state.message), ["a", "b", "c"]);
  assert.deepEqual(verdicts.map((v) => v.logId), rows.map((r) => r.id));
});

test("concurrency: never more Jev calls in flight than the limit, and every row still gets judged", async () => {
  for (let i = 0; i < 12; i++) add({ message: `row ${i}` });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { jev, asked, maxInFlight } = fakeJev(() => ({ hold: gate }));
  const { watcher, verdicts } = watch(jev, undefined, { concurrency: 3 });
  watcher.start();
  await until(() => asked.length === 3);
  await delay(100);
  assert.equal(asked.length, 3, "the other rows wait in the queue");
  assert.equal(maxInFlight(), 3);
  release();
  await until(() => verdicts.length === 12);
  assert.equal(maxInFlight(), 3);
});

test("concurrency: a failed call frees its slot", async () => {
  for (let i = 0; i < 5; i++) add();
  const { jev } = fakeJev(() => ({ error: Error("down") }));
  const { watcher, verdicts } = watch(jev, undefined, { concurrency: 1 });
  watcher.start();
  await until(() => verdicts.length === 5);
});

test("stop: no more polling after stop", async () => {
  const { jev, asked } = fakeJev();
  const { watcher, verdicts } = watch(jev);
  watcher.start();
  watcher.stop();
  add();
  await delay(700);
  assert.equal(asked.length, 0, "rows written after stop are never picked up");
  assert.equal(verdicts.length, 0);
});

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────────

test("incident threshold: two incident verdicts do nothing, the third opens an incident with all three row ids", async () => {
  const ids: number[] = [];
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident", probability: 0.9 }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  ids.push(add(BAD).id, add(BAD).id);
  watcher.start();
  await until(() => verdicts.length === 2);
  assert.equal(triggers.length, 0, "2 of 3");
  ids.push(add(BAD).id);
  await until(() => triggers.length === 1);
  assert.deepEqual(triggers[0], {
    fingerprint: "checkout-api · POST /v1/checkout · TypeError",
    decision: "incident",
    logIds: ids,
  });
});

test("incident threshold: it is per fingerprint, so mixed failures do not add up", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  add({ ...BAD, errorType: "TypeError" });
  add({ ...BAD, errorType: "RangeError" });
  add({ ...BAD, errorType: "SyntaxError" });
  add({ ...BAD, errorType: "TypeError" });
  watcher.start();
  await until(() => verdicts.length === 4);
  await delay(50);
  assert.equal(triggers.length, 0, "two TypeErrors, one of each other");
});

test("incident threshold: a verdict below 0.6 probability never triggers", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident", probability: 0.59 }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  for (let i = 0; i < 6; i++) add(BAD);
  watcher.start();
  await until(() => verdicts.length === 6);
  await delay(50);
  assert.equal(triggers.length, 0);
});

test("incident threshold: exactly 0.6 probability counts", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident", probability: 0.6 }));
  const { watcher } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  for (let i = 0; i < 3; i++) add(BAD);
  watcher.start();
  await until(() => triggers.length === 1);
});

test("incident threshold: only confident verdicts count toward it", async () => {
  // README: "Incident verdicts (probability 0.6 or more) with one fingerprint that open an incident."
  const triggers: Trigger[] = [];
  const { jev } = fakeJev((state) => ({ decision: "incident", probability: state.message === "weak" ? 0.3 : 0.9 }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  add({ ...BAD, message: "weak" });
  add({ ...BAD, message: "weak" });
  const confident = [add({ ...BAD, message: "strong" })];
  watcher.start();
  await until(() => verdicts.length === 3);
  await delay(50);
  assert.equal(triggers.length, 0, "two weak verdicts and one confident one are not three confident ones");
  confident.push(add({ ...BAD, message: "strong" }));
  await until(() => verdicts.length === 4);
  await delay(50);
  assert.equal(triggers.length, 0, "two confident, still short of three");
  confident.push(add({ ...BAD, message: "strong" }));
  await until(() => triggers.length === 1);
  assert.deepEqual(triggers[0].logIds, confident.map((r) => r.id), "the weak rows are not part of the evidence");
});

test("suspicious threshold: verdicts count at any probability, including ones stored with none", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev((_s, call) => ({ decision: "suspicious", probability: call % 2 ? 0.05 : 0.9 }));
  const { watcher } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1, suspiciousThreshold: 4 });
  for (let i = 0; i < 4; i++) add({ message: "odd", severity: "WARNING", status: null, method: null, route: null, latencyMs: null });
  watcher.start();
  await until(() => triggers.length === 1);
  assert.equal(triggers[0].logIds.length, 4);
});

test("suspicious threshold: seven do nothing, the eighth opens an incident", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "suspicious", probability: 0.4 }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  const warn = { severity: "WARNING" as const, service: "catalog-api", method: null, route: null, status: null, latencyMs: null, message: "slow query 1900ms: SELECT" };
  for (let i = 0; i < 7; i++) add(warn);
  watcher.start();
  await until(() => verdicts.length === 7);
  await delay(50);
  assert.equal(triggers.length, 0, "7 of 8");
  const eighth = add(warn);
  await until(() => triggers.length === 1);
  assert.equal(triggers[0].decision, "suspicious");
  assert.equal(triggers[0].logIds.length, 8);
  assert.equal(triggers[0].logIds.at(-1), eighth.id);
});

test("suspicious verdicts do not need 0.6 probability", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "suspicious", probability: 0.34 }));
  const { watcher } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1, suspiciousThreshold: 2 });
  add({ message: "odd" });
  add({ message: "odd" });
  watcher.start();
  await until(() => triggers.length === 1);
});

test("normal verdicts never trigger, however many there are", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "normal" }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  for (let i = 0; i < 20; i++) add({ message: "all good" });
  watcher.start();
  await until(() => verdicts.length === 20);
  await delay(50);
  assert.equal(triggers.length, 0);
});

test("thresholds are configurable", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1, incidentThreshold: 1 });
  add(BAD);
  watcher.start();
  await until(() => triggers.length === 1);
  assert.equal(triggers[0].logIds.length, 1);
});

test("window: verdicts for rows older than the window do not count toward the threshold", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), {
    concurrency: 1,
    windowMs: 60_000,
    backlogMs: 30 * 60_000,
  });
  add({ ...BAD, ts: minutesAgo(10) });
  add({ ...BAD, ts: minutesAgo(9) });
  add({ ...BAD });
  watcher.start();
  await until(() => verdicts.length === 3);
  await delay(50);
  assert.equal(triggers.length, 0, "two of the three are outside the 60s window");
  add({ ...BAD });
  add({ ...BAD });
  await until(() => triggers.length === 1);
  assert.equal(triggers[0].logIds.length, 3, "only the three recent rows");
});

// ── one incident per fingerprint ────────────────────────────────────────────────────────────────────

test("one trigger at a time per fingerprint: more bad rows while an incident is opening do not open another", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher, verdicts } = watch(
    jev,
    async (tr) => {
      triggers.push(tr);
      await pending;
    },
    { concurrency: 6 },
  );
  for (let i = 0; i < 10; i++) add(BAD);
  watcher.start();
  await until(() => verdicts.length === 10);
  assert.equal(triggers.length, 1, "ten verdicts, one trigger");
  release();
});

test("different fingerprints open their own incidents, even while another is still opening", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher } = watch(
    jev,
    async (tr) => {
      triggers.push(tr);
      await pending;
    },
    { concurrency: 6 },
  );
  for (let i = 0; i < 3; i++) add({ ...BAD, errorType: "TypeError" });
  for (let i = 0; i < 3; i++) add({ ...BAD, errorType: "RangeError" });
  watcher.start();
  await until(() => triggers.length === 2);
  assert.deepEqual(triggers.map((tr) => tr.fingerprint.split(" · ").at(-1)).sort(), ["RangeError", "TypeError"]);
  release();
});

test("once an opening finishes, a later verdict for the same fingerprint asks again (Ops.openIncident dedups)", async () => {
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher, verdicts } = watch(jev, async (tr) => void triggers.push(tr), { concurrency: 1 });
  for (let i = 0; i < 3; i++) add(BAD);
  watcher.start();
  await until(() => triggers.length === 1);
  add(BAD);
  await until(() => triggers.length === 2);
  assert.equal(triggers[1].logIds.length, 4);
  assert.equal(verdicts.length, 4);
});

test("a failing trigger handler is logged, frees the fingerprint, and the watcher keeps judging", async () => {
  let attempts = 0;
  const triggers: Trigger[] = [];
  const { jev } = fakeJev(() => ({ decision: "incident" }));
  const { watcher, verdicts } = watch(
    jev,
    async (tr) => {
      attempts++;
      if (attempts === 1) throw Error("could not open worktree");
      triggers.push(tr);
    },
    { concurrency: 1 },
  );
  for (let i = 0; i < 3; i++) add(BAD);
  watcher.start();
  await until(() => verdicts.length === 3);
  await until(() => errors.mock.callCount() >= 1);
  assert.match(String(errors.mock.calls[0].arguments[1]), /could not open worktree/);
  assert.equal(errors.mock.calls[0].arguments[0], "[watcher]");
  add(BAD);
  await until(() => triggers.length === 1);
  assert.equal(attempts, 2, "the fingerprint was released for a retry");
});

test("events: every new row emits 'log' once, every stored verdict emits 'verdict' once", async () => {
  const rows = [add(), add(), add({ ts: minutesAgo(30) })];
  const { jev } = fakeJev();
  const { watcher, verdicts, seen } = watch(jev, undefined, { backlogMs: 5 * 60_000 });
  watcher.start();
  await until(() => verdicts.length === 3);
  await delay(700);
  assert.deepEqual(seen.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
  assert.equal(verdicts.length, 3, "no repeats on later polls");
});
