import { test } from "node:test";
import assert from "node:assert/strict";
import { DpiError, isDpiError } from "../src/errors.js";
import { JOB_RUNS_DOC, jobRunDone, type JobRunStatus } from "../src/jobs.js";
import {
  API_VERSION,
  DEFAULT_COMPACTION,
  DEFAULT_COMPACTION_AT,
  THINKING_LEVELS,
  compactionFits,
  compactionThresholds,
  defaultCompaction,
} from "../src/api.js";

test("DpiError carries code, status and cause and identifies itself", () => {
  const cause = new Error("socket closed");
  const error = new DpiError("offline", "Cannot reach box", 0, { cause });
  assert.ok(error instanceof Error && error instanceof DpiError);
  assert.equal(error.name, "DpiError");
  assert.equal(error.code, "offline");
  assert.equal(error.message, "Cannot reach box");
  assert.equal(error.status, 0);
  assert.equal(error.cause, cause);
  assert.equal(new DpiError("not_found", "x", 404).status, 404);
  assert.equal(new DpiError("internal", "x").status, 0, "status defaults to 0");
  assert.equal(new DpiError("internal", "x").cause, undefined);
});

test("isDpiError accepts only DpiError instances", () => {
  assert.equal(isDpiError(new DpiError("internal", "x")), true);
  assert.equal(isDpiError(new Error("x")), false);
  assert.equal(isDpiError({ code: "offline", message: "x", name: "DpiError" }), false);
  assert.equal(isDpiError(undefined), false);
  assert.equal(isDpiError("offline"), false);
});

test("jobRunDone is true for every settled status and false while running or waiting", () => {
  const settled: JobRunStatus[] = ["completed", "failed", "aborted", "declined"];
  for (const status of settled) assert.equal(jobRunDone({ status }), true, status);
  for (const status of ["running", "waiting"] as const) assert.equal(jobRunDone({ status }), false, status);
  assert.equal(JOB_RUNS_DOC, "demo.job-runs");
});

test("API constants: version, thinking levels and compaction defaults", () => {
  assert.equal(API_VERSION, 1);
  assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(DEFAULT_COMPACTION_AT, { auto: 200_000, wait: 250_000 });
  assert.deepEqual(DEFAULT_COMPACTION, { enabled: true, reserveTokens: 16384, backgroundTokens: 32768, keepRecentTokens: 2000 });
});

test("defaultCompaction ignores an unknown window and returns a copy of the defaults", () => {
  for (const window of [0, -5, Number.NaN]) assert.deepEqual(defaultCompaction(window), DEFAULT_COMPACTION);
  const copy = defaultCompaction(0);
  copy.reserveTokens = 1;
  assert.equal(DEFAULT_COMPACTION.reserveTokens, 16384, "mutating the result must not touch the shared default");
});

test("defaultCompaction keeps the 200k/250k markers when the window allows and refits below that", () => {
  const big = defaultCompaction(1_000_000);
  assert.deepEqual(compactionThresholds(1_000_000, big), { auto: 200_000, wait: 250_000 });
  assert.equal(big.enabled, true);
  assert.equal(big.keepRecentTokens, 2000);
  // A 200k window cannot wait at 250k: the wait marker sits one reserve below the window.
  const small = defaultCompaction(200_000);
  assert.equal(small.reserveTokens, 16_384);
  assert.equal(small.backgroundTokens, 32_768);
  const { wait, auto } = compactionThresholds(200_000, small);
  assert.equal(wait, 183_616);
  assert.equal(auto, 150_848);
});

test("compactionThresholds: no background marker when backgroundTokens is 0, and never negative", () => {
  const base = { ...DEFAULT_COMPACTION, backgroundTokens: 0 };
  assert.deepEqual(compactionThresholds(100_000, base), { wait: 100_000 - 16_384, auto: undefined });
  assert.deepEqual(compactionThresholds(10_000, DEFAULT_COMPACTION), { wait: 0, auto: 0 });
});

test("compactionFits needs 32k tokens before the blocking marker", () => {
  const s = { ...DEFAULT_COMPACTION, reserveTokens: 1000 };
  assert.equal(compactionFits(33_768, s), true);
  assert.equal(compactionFits(33_767, s), false);
});
