// store.ts branches the walkthrough in store.test.ts does not reach: file locks, failed opens, what survives a
// restart, unreadable folders, sessions whose files vanished, and compaction refitting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Store, lockFile, WRITE_TOOLS } from "../src/store.js";
import { defaultCompaction } from "../../dpi-sdk/src/api.js";
import { faux, tempStore } from "./helpers.js";

test("lockFile: takes a lock holding our pid with owner-only permissions, and release removes it", async () => {
  const t = await tempStore();
  try {
    const path = join(t.root, "nested", "dir", "x.lock");
    const release = lockFile(path);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    release();
    assert.equal(existsSync(path), false);
    release(); // releasing twice is harmless
  } finally {
    await t.cleanup();
  }
});

test("lockFile: replaces a lock left by a process that is gone", async () => {
  const t = await tempStore();
  try {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    const path = join(t.root, "stale.lock");
    writeFileSync(path, String(child.pid));
    const release = lockFile(path);
    assert.equal(readFileSync(path, "utf8"), String(process.pid));
    release();
  } finally {
    await t.cleanup();
  }
});

test("lockFile: refuses a lock held by another live process and leaves it alone", async () => {
  const t = await tempStore();
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const path = join(t.root, "held.lock");
    writeFileSync(path, String(holder.pid));
    assert.throws(() => lockFile(path), new RegExp(`Database already owned by process ${holder.pid}: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(readFileSync(path, "utf8"), String(holder.pid), "the other owner's lock is untouched");
  } finally {
    holder.kill("SIGKILL");
    await once(holder, "exit");
    await t.cleanup();
  }
});

test("lockFile: our own pid in the file is taken over, so a restart in the same process works", async () => {
  const t = await tempStore();
  try {
    const path = join(t.root, "own.lock");
    const first = lockFile(path);
    const second = lockFile(path);
    second();
    assert.equal(existsSync(path), false);
    first(); // the first holder's release finds nothing to remove
  } finally {
    await t.cleanup();
  }
});

test("lockFile: a release never removes a lock that now belongs to someone else", async () => {
  const t = await tempStore();
  try {
    const path = join(t.root, "swapped.lock");
    const release = lockFile(path);
    writeFileSync(path, "999999999");
    release();
    assert.equal(readFileSync(path, "utf8"), "999999999");
  } finally {
    await t.cleanup();
  }
});

test("a failed open closes what it opened, releases its locks and can be retried", async () => {
  const t = await tempStore();
  try {
    mkdirSync(t.options.dataDir, { recursive: true });
    mkdirSync(join(t.options.dataDir, "app-state.sqlite")); // a folder where the database should be
    await assert.rejects(() => t.open());
    assert.equal(existsSync(join(t.options.dataDir, "catalog.sqlite.lock")), false, "the catalog lock was released");
    assert.equal(existsSync(join(t.options.dataDir, "app-state.sqlite.lock")), false, "the shared-state lock was released");
    await rm(join(t.options.dataDir, "app-state.sqlite"), { recursive: true });
    const store = await t.open();
    assert.equal(store.list().length, 0);
    await store.close();
  } finally {
    await t.cleanup();
  }
});

test("close releases every lock file", async () => {
  const t = await tempStore();
  try {
    const store = await t.open();
    const session = await store.create({ name: "Locks", cwd: t.work, model: faux });
    for (const path of [`${store.catalogPath}.lock`, `${store.sharedStatePath}.lock`, `${session.dbPath}.lock`]) assert.ok(existsSync(path), path);
    await store.close();
    for (const path of [`${store.catalogPath}.lock`, `${store.sharedStatePath}.lock`, `${session.dbPath}.lock`]) assert.equal(existsSync(path), false, path);
  } finally {
    await t.cleanup();
  }
});

test("the device uid, session names, agent names and compaction settings survive a restart", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const uid = store.uid;
    const session = await store.create({ name: "Persistent", cwd: t.work, model: faux });
    const { row } = await store.resolveAgent(session.id, "main");
    store.setAgentName(row, 1, "Lead");
    const other = await store.createAgent(row, { name: "Helper" });
    store.setCompaction(row, { reserveTokens: 20_000, keepRecentTokens: 4_000, enabled: false });
    await store.close();

    store = await t.open();
    assert.equal(store.uid, uid);
    assert.equal(store.deviceInfo().uid, uid);
    assert.equal(store.resolveSession("persistent").id, session.id);
    assert.equal((await store.resolveAgent(session.id, "lead")).c.id, 1);
    assert.equal((await store.resolveAgent(session.id, "helper")).c.id, other.id);
    assert.deepEqual(store.compactionOf(session.id), { enabled: false, reserveTokens: 20_000, backgroundTokens: store.compactionOf(session.id).backgroundTokens, keepRecentTokens: 4_000 });
    assert.equal((await store.tree()).sessions[0].compaction?.keepRecentTokens, 4_000);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("stored idempotency keys older than a day are dropped when the device opens, newer ones are kept", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    store.remember("fresh", "POST /x", 201, { ok: 1 });
    store.remember("old", "POST /x", 201, { ok: 2 });
    const catalogPath = store.catalogPath;
    await store.close();
    const db = new DatabaseSync(catalogPath);
    db.prepare("UPDATE requests SET createdAt=? WHERE key='old'").run(Date.now() - 25 * 3600_000);
    db.close();
    store = await t.open();
    assert.deepEqual(store.replay("fresh", "POST /x"), { status: 201, body: { ok: 1 } });
    assert.equal(store.replay("old", "POST /x"), undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("browse: a file is not a directory, hidden and node_modules folders are skipped, long lists are cut at 500", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const crowded = join(t.work, "crowded");
    await mkdir(crowded);
    for (let i = 0; i < 505; i++) await mkdir(join(crowded, `d${String(i).padStart(4, "0")}`));
    await mkdir(join(crowded, ".git"));
    await mkdir(join(crowded, "node_modules"));
    const listing = await store.browse(crowded);
    assert.equal(listing.dirs.length, 500);
    assert.equal(listing.dirs[0].name, "d0000");
    assert.ok(listing.dirs.every((d) => !d.name.startsWith(".") && d.name !== "node_modules"));
    await assert.rejects(() => store.browse(join(t.root, "data", "catalog.sqlite")), /Not a directory/);
    assert.equal((await store.browse("/")).parent, undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("browse: a folder that cannot be read is a 503 that names it", { skip: process.getuid?.() === 0 && "root can read everything" }, async () => {
  const t = await tempStore();
  const store = await t.open();
  const locked = join(t.work, "locked");
  try {
    await mkdir(locked);
    await chmod(locked, 0o000);
    await assert.rejects(
      () => store.browse(locked),
      (e: { status: number; code: string; message: string }) => e.status === 503 && e.code === "unavailable" && e.message.startsWith(`Cannot list ${locked}:`),
    );
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await store.close();
    await t.cleanup();
  }
});

test("a session whose files vanished is listed with an error, answers 503, and can still be archived", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const keep = await store.create({ name: "Keeper", cwd: t.work, model: faux });
    const lost = await store.create({ name: "Lost", cwd: t.work, model: faux });
    await store.close();
    await rm(join(t.options.dataDir, "sessions", lost.id), { recursive: true });

    store = await t.open();
    const tree = await store.tree();
    const summary = tree.sessions.find((s) => s.id === lost.id)!;
    assert.equal(summary.agents.length, 0);
    assert.equal(summary.busy, false);
    assert.match(summary.error ?? "", /ENOENT|no such file/i);
    assert.equal(tree.sessions.find((s) => s.id === keep.id)!.error, undefined, "the healthy session is unaffected");
    assert.throws(() => store.harness(store.row(lost.id)), (e: { status: number }) => e.status === 503);
    await assert.rejects(() => store.resolveAgent(lost.id, "main"), (e: { status: number }) => e.status === 503);

    const { archived } = await store.archive(store.row(lost.id));
    assert.ok(archived.includes(lost.id));
    assert.deepEqual(store.list().map((r) => r.id), [keep.id]);
    assert.equal((await store.tree()).sessions.length, 1);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("archiving an open session stops its work and keeps the files in the archive", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Busy", cwd: t.work, model: faux });
    const { h, c, row } = await store.resolveAgent(session.id, "main");
    await store.send(c, { content: "!sleep 30", requestId: "arch-1" });
    for (let i = 0; i < 100 && !(await store.liveTasks(h)).some((x) => x.kind === "pi.tool"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok((await store.liveTasks(h)).length > 0, "work is running");
    const { archived } = await store.archive(row);
    assert.ok(existsSync(join(archived, "agent.sqlite")));
    assert.equal(existsSync(`${session.dbPath}.lock`), false, "the session lock is released");
    assert.equal(store.opened.has(session.id), false);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("changing to a model whose window is too small for the thresholds refits them", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Refit", cwd: t.work, model: faux });
    const { row, c } = await store.resolveAgent(session.id, "main");
    store.setCompaction(row, { reserveTokens: 100_000, backgroundTokens: 100_000 });
    assert.equal(store.compactionOf(session.id).reserveTokens, 100_000);
    await store.configure(row, c, { thinkingLevel: "low" });
    assert.equal(store.compactionOf(session.id).reserveTokens, 100_000, "no model change, no refit");
    await store.configure(row, c, { model: faux });
    const fitted = defaultCompaction(128_000);
    assert.equal(store.compactionOf(session.id).reserveTokens, fitted.reserveTokens);
    assert.equal(store.compactionOf(session.id).backgroundTokens, fitted.backgroundTokens);
    assert.equal(store.compactionOf(session.id).keepRecentTokens, 2000, "other settings are kept");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("compaction defaults follow the model window", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Window", cwd: t.work, model: faux });
    assert.deepEqual(store.compactionOf(session.id), defaultCompaction(128_000));
    assert.deepEqual(store.compactionOf("no-such-session"), defaultCompaction(0), "an unknown session gets the plain defaults");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("setCompaction: only the stated fields change and the stored copy is not shared with the caller", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Copy", cwd: t.work, model: faux });
    const { row } = await store.resolveAgent(session.id, "main");
    const before = store.compactionOf(session.id);
    const returned = store.setCompaction(row, { keepRecentTokens: 3000 });
    assert.deepEqual(returned, { ...before, keepRecentTokens: 3000 });
    returned.keepRecentTokens = 1;
    assert.equal(store.compactionOf(session.id).keepRecentTokens, 3000);
    assert.throws(() => store.setCompaction(row, { backgroundTokens: 1_000_001 }), /backgroundTokens must be an integer from 0 to 1000000/);
    assert.throws(() => store.setCompaction(row, { enabled: 1 }), /enabled must be a boolean/);
    assert.equal(store.compactionOf(session.id).keepRecentTokens, 3000);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("setAgentName and rename keep names to 100 characters and reject numbers and 'main'", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Names", cwd: t.work, model: faux });
    const { row } = await store.resolveAgent(session.id, "main");
    const other = await store.createAgent(row, {});
    assert.throws(() => store.setAgentName(row, other.id, "007"), /cannot be numbers or 'main'/);
    assert.throws(() => store.setAgentName(row, other.id, "MAIN"), /cannot be numbers or 'main'/);
    assert.throws(() => store.setAgentName(row, other.id, undefined), /A name is required/);
    store.setAgentName(row, 1, "main"); // Main itself may be called main
    store.setAgentName(row, other.id, "x".repeat(300));
    assert.equal((await store.agentSummary(row, (await store.resolveAgent(session.id, String(other.id))).c)).name.length, 100);
    store.setAgentName(row, other.id, "Renamed");
    store.setAgentName(row, other.id, "Renamed again");
    assert.equal((await store.resolveAgent(session.id, "renamed again")).c.id, other.id);
    await assert.rejects(() => store.resolveAgent(session.id, "Renamed"), /No agent "Renamed"/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("fork, createAgent and the lookups reject bad input with plain messages", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Misc", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    await assert.rejects(() => store.fork(row, c, {}), /entryId is required/);
    await assert.rejects(() => store.fork(row, c, { entryId: "x" }), /entryId is required/);
    await assert.rejects(() => store.fork(row, c, { entryId: 1, name: 5 }), /Invalid fork name/);
    assert.deepEqual(await store.withdraw(h, c, 424242), { status: "not_found" });
    await assert.rejects(() => store.settled(h, 424242), /No submission 424242/);
    await assert.rejects(() => store.abortTask(h, 424242), /No task 424242/);
    await assert.rejects(() => store.agentDoc(h, c, "nope"), /Unknown agent document nope/);
    await assert.rejects(() => store.deviceDoc("nope"), /Unknown device document nope/);
    await assert.rejects(() => store.createAgent(row, { from: "ghost" }), /No agent "ghost"/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("send validates its body and settled reports queued, pending and done", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Send", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    await assert.rejects(() => store.send(c, {}), /content must be a message/);
    await assert.rejects(() => store.send(c, { content: "x" }), /requestId is required/);
    await assert.rejects(() => store.send(c, { content: "x", requestId: "r", whenBusy: "never" }), /whenBusy must be/);
    const slow = await store.send(c, { content: "!sleep 1; echo ok", requestId: "s-1" });
    const early = await store.settled(h, slow.id as number, 100);
    assert.ok(["queued", "pending"].includes(early.status), early.status);
    const done = await store.settled(h, slow.id as number, 20_000);
    assert.equal(done.status, "done");
    assert.equal(done.status === "done" && done.answer.text.startsWith("Tool finished"), true);
    // An aborted wait comes back without throwing.
    const next = await store.send(c, { content: "!sleep 2", requestId: "s-2" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const cut = await store.settled(h, next.id as number, 60_000, controller.signal);
    assert.ok(Date.now() - started < 5000, "the wait ended with the signal");
    assert.ok(["queued", "pending", "done"].includes(cut.status));
    await store.abort(c, true);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("WRITE_TOOLS names exactly the tools that change things", () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ["bash", "edit", "ping_on_call_engineer", "run_durable_job", "start_session", "subagent", "update_state", "write"]);
});

test("a session database that cannot be opened is listed with its error, releases its lock and does not stop the device", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const good = await store.create({ name: "Good", cwd: t.work, model: faux });
    const broken = await store.create({ name: "Broken", cwd: t.work, model: faux });
    await store.close();
    writeFileSync(broken.dbPath, "this is not a sqlite database, just text ".repeat(50));

    store = await t.open();
    const tree = await store.tree();
    const summary = tree.sessions.find((s) => s.id === broken.id)!;
    assert.ok(summary.error && summary.error.length > 0, "the error is shown");
    assert.equal(tree.sessions.find((s) => s.id === good.id)!.error, undefined);
    assert.equal(existsSync(`${broken.dbPath}.lock`), false, "the failed open left no lock behind");
    assert.equal(store.errors.get(broken.id), summary.error);
    // The healthy session still works.
    const { h, c } = await store.resolveAgent(good.id, "main");
    const sent = await store.send(c, { content: "still here", requestId: "ok-1" });
    assert.equal((await store.settled(h, sent.id as number, 15000)).status, "done");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("compact returns a task id whatever the instructions are, the task finishes, and the history and the agent are intact", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Compact", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    for (const word of ["alpha", "bravo", "charlie", "delta"]) {
      const sent = await store.send(c, { content: `remember ${word}`, requestId: `c-${word}` });
      assert.equal((await store.settled(h, sent.id as number, 15000)).status, "done");
    }
    const withNotes = await store.compact(c, "  keep the names  ");
    assert.equal(typeof withNotes.taskId, "number");
    const blank = await store.compact(c, "   ");
    const none = await store.compact(c);
    const wrongType = await store.compact(c, 42);
    for (const started of [blank, none, wrongType]) assert.equal(typeof started.taskId, "number");
    for (let i = 0; i < 200 && (await store.liveTasks(h)).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await store.liveTasks(h)).length, 0, "compaction tasks finished");
    const all = (await store.entries(c, undefined, 500)).items;
    for (const word of ["alpha", "bravo", "charlie", "delta"]) assert.ok(JSON.stringify(all).includes(`remember ${word}`), `${word} is still stored`);
    // And the agent keeps answering afterwards.
    const sent = await store.send(c, { content: "after compaction", requestId: "c-after" });
    const answer = await store.settled(h, sent.id as number, 15000);
    assert.equal(answer.status === "done" && answer.answer.text, "Echo: after compaction");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
