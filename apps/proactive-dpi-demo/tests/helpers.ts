// Shared test helpers: temp dirs, a temp checkout-api repo built from the mock template, and fixtures.
// Nothing here touches the demo's real `.data/` or `workspace/`, and nothing reads the project `.env`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { templateDir } from "../shared/paths.ts";
import { ensureLogSchema } from "../shared/log-store.ts";
import type { LogEntry, LogRow, Severity } from "../shared/types.ts";

// config.ts loads the project .env at import time. Tests never want real keys in the process.
process.loadEnvFile = () => {};

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(fn: () => boolean | Promise<boolean>, timeout = 10_000, what = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw Error(`Timed out waiting for ${what}`);
}

/** A fresh temp directory removed by the returned `cleanup`. */
export function tempDir(prefix = "proactive-test-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** The mock checkout-api repo, built the way `npm run reset` does, but in a temp dir and without `npm test`. */
export function makeCheckoutRepo(root: string) {
  const repo = join(root, "checkout-api");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Proactive DPI Agent");
  git(repo, "config", "user.email", "agent@lumen.market");
  git(repo, "config", "commit.gpgsign", "false");
  const commits = JSON.parse(readFileSync(join(templateDir, "commits.json"), "utf8")) as {
    dir: string;
    message: string;
  }[];
  for (const commit of commits) {
    cpSync(join(templateDir, commit.dir), repo, { recursive: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", commit.message);
  }
  return repo;
}

let nextId = 1;

/** A log row with sensible defaults. `entry.jsonPayload` follows `message`. */
export function makeRow(over: Partial<Omit<LogRow, "entry">> & { entry?: Partial<LogEntry> } = {}): LogRow {
  const id = over.id ?? nextId++;
  const ts = over.ts ?? new Date().toISOString();
  const { entry: entryOver, ...rest } = over;
  const message = rest.message ?? "checkout completed";
  const severity: Severity = rest.severity ?? "INFO";
  const entry: LogEntry = {
    insertId: `ins-${id}-${Math.random().toString(36).slice(2, 8)}`,
    logName: "projects/p/logs/run.googleapis.com%2Frequests",
    resource: { type: "cloud_run_revision", labels: {} },
    timestamp: ts,
    receiveTimestamp: ts,
    severity,
    jsonPayload: { message },
    ...entryOver,
  };
  return {
    id,
    ts,
    severity,
    service: "checkout-api",
    revision: "checkout-api-00041-rup",
    method: "POST",
    route: "/v1/checkout",
    status: 200,
    latencyMs: 120,
    message,
    errorType: null,
    entry,
    ...rest,
  };
}

/** Insert a row (as the logs process does) into a log database. Returns its id. */
export function insertLog(db: DatabaseSync, row: LogRow, schema = "main"): number {
  const result = db
    .prepare(
      `INSERT INTO ${schema}.logs(insert_id, ts, severity, service, revision, method, route, status, latency_ms, message, error_type, entry) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.entry.insertId,
      row.ts,
      row.severity,
      row.service,
      row.revision,
      row.method,
      row.route,
      row.status,
      row.latencyMs,
      row.message,
      row.errorType,
      JSON.stringify(row.entry),
    );
  return Number(result.lastInsertRowid);
}

/** A logs.sqlite in `dir` with the real schema. */
export function openLogDb(dir: string) {
  const db = new DatabaseSync(join(dir, "logs.sqlite"));
  ensureLogSchema(db);
  return db;
}

/** Set env vars for one test and restore them afterwards. `undefined` deletes. */
export function withEnv(vars: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** The guest-checkout fix for the mock repo's bug. */
export const FIX = `import type { Customer, LoyaltyTier } from "../types.ts";

const TIER_RATES: Record<LoyaltyTier, number> = {
  silver: 0.03,
  gold: 0.05,
  platinum: 0.08,
};

/** Discount in cents for a loyalty member's order. Guests have no loyalty data and get none. */
export function loyaltyDiscount(customer: Customer, subtotalCents: number): number {
  if (!customer.loyalty) return 0;
  return Math.round(subtotalCents * TIER_RATES[customer.loyalty.tier]);
}
`;

/** A regression test that fails on main and passes with FIX. */
export const REGRESSION = `import { test } from "node:test";
import assert from "node:assert/strict";
import { loyaltyDiscount } from "../src/pricing/loyalty.ts";

test("guests get no loyalty discount instead of crashing", () => {
  assert.equal(loyaltyDiscount({ id: "gst_1", guest: true, region: "us-ca" }, 10000), 0);
});
`;

