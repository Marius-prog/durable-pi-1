import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "./helpers.ts";
import { tempDir, makeRow, insertLog } from "./helpers.ts";
import { lockFile, lockOwner } from "../shared/lock.ts";
import * as paths from "../shared/paths.ts";
import {
  LOG_COLUMNS,
  demoState,
  ensureLogSchema,
  readControl,
  toLogRow,
  writeControl,
} from "../shared/log-store.ts";

test("paths: every location lives under the demo directory and the repo is inside the workspace", () => {
  assert.ok(isAbsolute(paths.demoDir));
  assert.ok(existsSync(join(paths.demoDir, "package.json")), "demoDir is the app folder");
  for (const key of ["dataDir", "workspaceDir", "templateDir"] as const)
    assert.ok(!relative(paths.demoDir, paths[key]).startsWith(".."), `${key} is under demoDir`);
  for (const key of ["ttsDir", "logsDbPath", "watchDbPath", "agentDbPath"] as const)
    assert.ok(!relative(paths.dataDir, paths[key]).startsWith(".."), `${key} is under dataDir`);
  assert.equal(paths.repoDir, join(paths.workspaceDir, "checkout-api"));
  assert.equal(paths.worktreesDir, join(paths.workspaceDir, "incidents"));
  assert.equal(paths.projectEnvPath.endsWith(".env"), true);
  assert.ok(existsSync(join(paths.templateDir, "commits.json")), "the template ships with the app");
});

test("lockOwner: missing, own, foreign-live, and stale lock files", async () => {
  const t = tempDir();
  try {
    const path = join(t.root, "x.lock");
    assert.equal(lockOwner(path), undefined, "no file, no owner");
    writeFileSync(path, String(process.pid));
    assert.equal(lockOwner(path), process.pid);
    // pid 1 is always alive: kill(1, 0) succeeds, or fails with EPERM, which counts as alive too.
    writeFileSync(path, "1");
    assert.equal(lockOwner(path), 1);
    // A pid that has exited is a stale lock.
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.once("exit", r));
    writeFileSync(path, String(child.pid));
    assert.equal(lockOwner(path), undefined);
  } finally {
    t.cleanup();
  }
});

test("lockFile: creates the directory, writes our pid at mode 0600, and release removes it", () => {
  const t = tempDir();
  try {
    const path = join(t.root, "deep", "dir", "agent.sqlite.lock");
    const release = lockFile(path);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // Our own lock may be taken again (a restart in the same process).
    const again = lockFile(path);
    again();
    assert.equal(existsSync(path), false);
    release();
    release(); // releasing twice is harmless
    assert.equal(existsSync(path), false);
  } finally {
    t.cleanup();
  }
});

test("lockFile: refuses a live foreign owner and takes over a stale lock", async () => {
  const t = tempDir();
  try {
    const path = join(t.root, "a.lock");
    writeFileSync(path, "1");
    assert.throws(() => lockFile(path), /Already owned by process 1: /);
    assert.equal(readFileSync(path, "utf8"), "1", "a refused lock leaves the owner's file alone");

    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.once("exit", r));
    writeFileSync(path, String(child.pid));
    const release = lockFile(path);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    release();
  } finally {
    t.cleanup();
  }
});

test("lockFile: release never deletes a lock another process has since taken", () => {
  const t = tempDir();
  try {
    const path = join(t.root, "b.lock");
    const release = lockFile(path);
    writeFileSync(path, "1");
    release();
    assert.equal(readFileSync(path, "utf8"), "1");
  } finally {
    t.cleanup();
  }
});

// Real bug (shared/lock.ts, lockOwner): an empty lock file reads as pid 0, and kill(0, 0) signals the
// whole process group and succeeds, so the lock looks owned by "process 0". A garbage file reads as NaN,
// which makes kill throw a non-ESRCH error, so it also looks owned. Either way the app refuses to start
// until someone deletes the file by hand. Un-todo this test when lockOwner ignores unparsable contents.
test.todo("lockOwner treats an empty or non-numeric lock file as stale");

test("ensureLogSchema: creates logs and control, is idempotent, and enforces unique insert ids", () => {
  const db = new DatabaseSync(":memory:");
  ensureLogSchema(db);
  ensureLogSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('logs','control') ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ["control", "logs"]);
  const row = makeRow();
  insertLog(db, row);
  assert.throws(() => insertLog(db, row), /UNIQUE/);
  db.close();
});

test("ensureLogSchema: works against an attached database", () => {
  const t = tempDir();
  try {
    const db = new DatabaseSync(join(t.root, "watch.sqlite"));
    db.prepare("ATTACH DATABASE ? AS lg").run(join(t.root, "logs.sqlite"));
    ensureLogSchema(db, "lg");
    const row = makeRow({ message: "hello" });
    const id = insertLog(db, row, "lg");
    const stored = db.prepare(`SELECT ${LOG_COLUMNS} FROM lg.logs WHERE id = ?`).get(id);
    const parsed = toLogRow(stored as Record<string, unknown>);
    assert.equal(parsed.message, "hello");
    writeControl(db, "k", "v", "lg");
    assert.deepEqual(readControl(db, "lg"), { k: "v" });
    db.close();
  } finally {
    t.cleanup();
  }
});

test("toLogRow: aliases snake_case columns and parses the stored entry", () => {
  const db = new DatabaseSync(":memory:");
  ensureLogSchema(db);
  const row = makeRow({ id: 7, latencyMs: 321, errorType: "TypeError", status: 500, severity: "ERROR" });
  const id = insertLog(db, row);
  const stored = db.prepare(`SELECT ${LOG_COLUMNS} FROM logs WHERE id = ?`).get(id) as Record<string, unknown>;
  const parsed = toLogRow(stored);
  assert.equal(parsed.latencyMs, 321);
  assert.equal(parsed.errorType, "TypeError");
  assert.equal(parsed.status, 500);
  assert.deepEqual(parsed.entry, row.entry);
  assert.equal(typeof parsed.entry, "object");
  db.close();
});

test("writeControl / readControl: upsert, overwrite, and null deletes", () => {
  const db = new DatabaseSync(":memory:");
  ensureLogSchema(db);
  assert.deepEqual(readControl(db), {});
  writeControl(db, "rate", "2");
  writeControl(db, "bug_at", "100");
  writeControl(db, "rate", "5");
  assert.deepEqual(readControl(db), { rate: "5", bug_at: "100" });
  writeControl(db, "bug_at", null);
  assert.deepEqual(readControl(db), { rate: "5" });
  writeControl(db, "missing", null); // deleting an absent key is a no-op
  assert.deepEqual(readControl(db), { rate: "5" });
  db.close();
});

test("demoState: maps control keys to numbers, nulls and revision names", () => {
  assert.deepEqual(demoState({}), {
    startedAt: null,
    bugAt: null,
    bugInjectedAt: null,
    rate: null,
    goodRevision: null,
    badRevision: null,
    liveRevision: null,
  });
  assert.deepEqual(
    demoState({
      started_at: "1000",
      bug_at: "6000",
      bug_injected_at: "6100",
      rate: "2",
      good_revision: "a abc",
      bad_revision: "b def",
      live_revision: "b",
    }),
    {
      startedAt: 1000,
      bugAt: 6000,
      bugInjectedAt: 6100,
      rate: 2,
      goodRevision: "a abc",
      badRevision: "b def",
      liveRevision: "b",
    },
  );
});
