import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIX, REGRESSION, git, makeCheckoutRepo, tempDir, withEnv } from "./helpers.ts";
import { branchReview, ensureWorktree, verifyAndCommit } from "../apps/proactive-dpi-be/src/repo.ts";

const t = tempDir();
let repo: string;
let n = 0;

before(() => {
  repo = makeCheckoutRepo(t.root);
});
after(() => t.cleanup());

/** A fresh incident worktree and branch off main. */
function incident() {
  const slug = `inc-${String(++n).padStart(4, "0")}`;
  const path = join(t.root, "incidents", slug);
  ensureWorktree(`incident/${slug}`, path, repo);
  return { slug, branch: `incident/${slug}`, path };
}

function write(path: string, rel: string, text: string) {
  mkdirSync(join(path, rel, ".."), { recursive: true });
  writeFileSync(join(path, rel), text);
}

test("ensureWorktree: creates the branch from main in a new worktree", () => {
  const w = incident();
  assert.ok(existsSync(join(w.path, ".git")));
  assert.equal(git(w.path, "rev-parse", "--abbrev-ref", "HEAD"), w.branch);
  assert.equal(git(w.path, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
  assert.ok(existsSync(join(w.path, "src/pricing/loyalty.ts")), "the checkout-api files are there");
  assert.match(git(repo, "worktree", "list"), new RegExp(w.slug));
});

test("ensureWorktree: running it again is a no-op", () => {
  const w = incident();
  write(w.path, "scratch.txt", "keep me");
  ensureWorktree(w.branch, w.path, repo);
  assert.equal(readFileSync(join(w.path, "scratch.txt"), "utf8"), "keep me");
  assert.equal(git(repo, "worktree", "list").split("\n").filter((l) => l.includes(w.slug)).length, 1);
});

test("ensureWorktree: after a crash that lost the folder, the existing branch is checked out again with its commits", () => {
  const w = incident();
  write(w.path, "work.txt", "progress");
  git(w.path, "add", "-A");
  git(w.path, "commit", "-q", "-m", "wip");
  const head = git(w.path, "rev-parse", "HEAD");
  rmSync(w.path, { recursive: true, force: true });
  ensureWorktree(w.branch, w.path, repo);
  assert.equal(git(w.path, "rev-parse", "HEAD"), head, "the branch kept its commit");
  assert.equal(readFileSync(join(w.path, "work.txt"), "utf8"), "progress");
});

test("branchReview: a folder that is not a worktree reviews as empty", () => {
  assert.deepEqual(branchReview(join(t.root, "nowhere")), { ahead: 0, head: null, log: "", diffStat: "", diff: "" });
});

test("branchReview: a fresh branch is level with main", () => {
  const w = incident();
  const review = branchReview(w.path);
  assert.equal(review.ahead, 0);
  assert.equal(review.head, git(repo, "rev-parse", "--short", "main"));
  assert.equal(review.log, "");
  assert.equal(review.diffStat, "");
  assert.equal(review.diff, "");
});

test("branchReview: lists the branch's commits and diffs them against main", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  git(w.path, "add", "-A");
  git(w.path, "commit", "-q", "-m", "fix(pricing): guests have no loyalty (INC-0001)");
  write(w.path, "NOTES.md", "second commit\n");
  git(w.path, "add", "-A");
  git(w.path, "commit", "-q", "-m", "docs: notes");
  const review = branchReview(w.path);
  assert.equal(review.ahead, 2);
  assert.equal(review.head, git(w.path, "rev-parse", "--short", "HEAD"));
  const lines = review.log.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^[0-9a-f]{7,} Proactive DPI Agent: docs: notes$/, "newest first, with the author");
  assert.match(lines[1], /: fix\(pricing\): guests have no loyalty \(INC-0001\)$/);
  assert.match(review.diffStat, /src\/pricing\/loyalty\.ts/);
  assert.match(review.diffStat, /NOTES\.md/);
  assert.match(review.diff, /\+  if \(!customer\.loyalty\) return 0;/);
  assert.match(review.diff, /-  const rate = TIER_RATES\[customer\.loyalty!\.tier\];/);
});

test("branchReview: the diff is against where the branch left main, not main's newer commits", () => {
  const w = incident();
  write(w.path, "branch-only.txt", "x");
  git(w.path, "add", "-A");
  git(w.path, "commit", "-q", "-m", "branch change");
  // main moves on in the primary checkout (a different branch checkout would be refused; use a plumbing commit).
  const tree = git(repo, "rev-parse", "main^{tree}");
  const newer = git(repo, "commit-tree", tree, "-p", "main", "-m", "main moved");
  git(repo, "update-ref", "refs/heads/main", newer);
  try {
    const review = branchReview(w.path);
    assert.equal(review.ahead, 1, "only the branch's own commit");
    assert.match(review.diffStat, /branch-only\.txt/);
    assert.ok(!review.diffStat.includes("main moved"));
  } finally {
    git(repo, "update-ref", "refs/heads/main", git(repo, "rev-parse", `${newer}^`));
  }
});

// ── verifyAndCommit ─────────────────────────────────────────────────────────────────────────────────

test("verifyAndCommit: refuses when nothing differs from main", () => {
  const w = incident();
  assert.throws(() => verifyAndCommit(w.path, "fix: nothing"), /Nothing differs from main yet/);
});

test("verifyAndCommit: refuses a fix without a regression test under test/", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  assert.throws(() => verifyAndCommit(w.path, "fix: no test"), /Add a regression test under test\/ that reproduces the failure/);
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "0", "nothing was committed");
});

test("verifyAndCommit: a test outside test/ or not named *.test.ts does not count", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "src/guest.test.ts", REGRESSION);
  write(w.path, "test/guest.spec.ts", REGRESSION);
  assert.throws(() => verifyAndCommit(w.path, "fix"), /Add a regression test/);
});

test("verifyAndCommit: refuses a regression test that passes on main, and says so with the counts", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/always-green.test.ts", `import { test } from "node:test";\ntest("trivially true", () => {});\n`);
  assert.throws(
    () => verifyAndCommit(w.path, "fix: weak test"),
    (e: Error) => /The regression test passes on main, so it does not reproduce the failure\./.test(e.message) && /tests 1/.test(e.message) && /pass 1/.test(e.message),
  );
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "0");
});

test("verifyAndCommit: refuses when the suite fails with the fix", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  // A change that breaks an existing test: member discounts drop to zero.
  write(w.path, "src/pricing/tax.ts", readFileSync(join(w.path, "src/pricing/tax.ts"), "utf8").replace("DEFAULT_RATE = 0.06", "DEFAULT_RATE = 0.5"));
  assert.throws(
    () => verifyAndCommit(w.path, "fix: breaks the suite"),
    (e: Error) => /^The suite fails with the fix\./.test(e.message) && /fail [1-9]/.test(e.message),
  );
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "0", "nothing committed after a failed proof");
});

test("verifyAndCommit: proves the test fails on main and the suite passes on the branch, then commits", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  const proof = verifyAndCommit(w.path, "fix(pricing): guests have no loyalty data (INC-0001)");
  assert.equal(proof.head, git(w.path, "rev-parse", "--short", "HEAD"));
  assert.match(proof.before, /tests 1/);
  assert.match(proof.before, /fail 1/, "the regression test failed on main's code");
  assert.match(proof.before, /guests get no loyalty discount instead of crashing/, "the failing test is named");
  assert.match(proof.after, /pass \d+/);
  assert.match(proof.after, /fail 0/);
  assert.match(proof.diffStat, /src\/pricing\/loyalty\.ts/);
  assert.match(proof.diffStat, /test\/guest\.test\.ts/);
  assert.equal(git(w.path, "log", "-1", "--format=%s"), "fix(pricing): guests have no loyalty data (INC-0001)");
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "1");
  assert.equal(git(w.path, "status", "--porcelain"), "", "everything is committed");
});

test("verifyAndCommit: leaves main alone", () => {
  const before = git(repo, "rev-parse", "main");
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  verifyAndCommit(w.path, "fix: x");
  assert.equal(git(repo, "rev-parse", "main"), before);
  assert.match(readFileSync(join(repo, "src/pricing/loyalty.ts"), "utf8"), /customer\.loyalty!\.tier/, "the buggy code is still on main");
});

test("verifyAndCommit: running it again after success reuses the commit instead of adding another", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  const first = verifyAndCommit(w.path, "fix: once");
  const second = verifyAndCommit(w.path, "fix: twice");
  assert.equal(second.head, first.head);
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "1");
  assert.equal(git(w.path, "log", "-1", "--format=%s"), "fix: once");
});

test("verifyAndCommit: a later change after a commit adds a second commit", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  const first = verifyAndCommit(w.path, "fix: first");
  write(w.path, "test/guest.test.ts", REGRESSION + `\ntest("members still get a discount", () => {\n  assert.equal(loyaltyDiscount({ id: "c", guest: false, region: "us-ca", loyalty: { tier: "gold", points: 1 } }, 10000), 500);\n});\n`);
  const second = verifyAndCommit(w.path, "fix: second");
  assert.notEqual(second.head, first.head);
  assert.equal(git(w.path, "rev-list", "--count", "main..HEAD"), "2");
});

test("verifyAndCommit: a regression test the agent deleted is not run", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(w.path, "test/guest.test.ts", REGRESSION);
  write(w.path, "test/gone.test.ts", `import { test } from "node:test";\ntest("x", () => {});\n`);
  git(w.path, "add", "-A");
  rmSync(join(w.path, "test/gone.test.ts"));
  const proof = verifyAndCommit(w.path, "fix: deleted test");
  assert.match(proof.before, /tests 1/, "only the surviving test ran on main");
});

test("verifyAndCommit: its scratch checkout of main is removed, pass or fail", () => {
  // Point TMPDIR at a private folder so other test processes running at the same time cannot show up in it.
  const scratchRoot = join(t.root, "tmp-scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const restore = withEnv({ TMPDIR: scratchRoot });
  try {
    const ok = incident();
    write(ok.path, "src/pricing/loyalty.ts", FIX);
    write(ok.path, "test/guest.test.ts", REGRESSION);
    verifyAndCommit(ok.path, "fix: ok");
    const weak = incident();
    write(weak.path, "src/pricing/loyalty.ts", FIX);
    write(weak.path, "test/green.test.ts", `import { test } from "node:test";\ntest("x", () => {});\n`);
    assert.throws(() => verifyAndCommit(weak.path, "fix: weak"));
    assert.deepEqual(readdirSync(scratchRoot), []);
  } finally {
    restore();
  }
});

test("verifyAndCommit: the tests run without the host's API keys", () => {
  const w = incident();
  write(w.path, "src/pricing/loyalty.ts", FIX);
  write(
    w.path,
    "test/env.test.ts",
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { loyaltyDiscount } from "../src/pricing/loyalty.ts";\ntest("no secrets in the environment", () => {\n  assert.equal(process.env.OPENROUTER_API_KEY, undefined);\n  assert.equal(process.env.LEAK_CHECK, undefined);\n  assert.equal(loyaltyDiscount({ id: "g", guest: true, region: "us-ca" }, 100), 0);\n});\n`,
  );
  process.env.LEAK_CHECK = "leaked";
  try {
    // On main the guest call throws, so the env assertions pass and the test still fails there. On the branch it passes.
    const proof = verifyAndCommit(w.path, "fix: env");
    assert.match(proof.after, /fail 0/);
  } finally {
    delete process.env.LEAK_CHECK;
  }
});
