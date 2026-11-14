import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_ID, DEVICE_KINDS, NetworkRegistry, dpiHome, normalizeUrl, toPublic, validateToken } from "../src/node/registry.js";
import type { DeviceInfo, DeviceTree } from "../src/api.js";

const token = (c: string) => "dpi_" + c.repeat(40);

async function withRegistry(fn: (reg: NetworkRegistry, dir: string) => Promise<void> | void) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dpi-reg2-")));
  const reg = new NetworkRegistry(join(dir, "network.sqlite"));
  try {
    await fn(reg, dir);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const info = (uid = "u1"): DeviceInfo => ({ uid, name: "box", models: [] }) as unknown as DeviceInfo;
const tree = (uid = "u1"): DeviceTree => ({ uid, name: "box", sessions: [], at: 1 });

// ------------------------------------------------------------------ pure helpers

test("normalizeUrl trims, drops trailing slashes, keeps path and port, and rejects query, fragment and other schemes", () => {
  assert.equal(normalizeUrl("  http://box:4780/  "), "http://box:4780");
  assert.equal(normalizeUrl("https://Example.COM///"), "https://example.com");
  assert.equal(normalizeUrl("https://host.test/base/path/"), "https://host.test/base/path");
  assert.equal(normalizeUrl("http://127.0.0.1:80"), "http://127.0.0.1");
  assert.throws(() => normalizeUrl("http://x/?a=1"), /query or fragment/);
  assert.throws(() => normalizeUrl("http://x/#top"), /query or fragment/);
  assert.throws(() => normalizeUrl("ftp://x"), /http or https/);
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /http or https/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /http or https/);
  assert.throws(() => normalizeUrl("no scheme"), /Invalid URL: no scheme/);
  assert.throws(() => normalizeUrl(""), /Invalid URL/);
});

test("validateToken needs 32+ characters without whitespace and returns the token", () => {
  assert.equal(validateToken("a".repeat(32)), "a".repeat(32));
  assert.throws(() => validateToken("a".repeat(31)), /at least 32 characters/);
  assert.throws(() => validateToken("a".repeat(16) + " " + "b".repeat(16)), /whitespace/);
  assert.throws(() => validateToken("a".repeat(40) + "\n"), /whitespace/);
  assert.throws(() => validateToken(""), /at least 32 characters/);
});

test("device ids are short lowercase slugs and kinds are the four known ones", () => {
  for (const ok of ["a", "box-1", "0x", "a".repeat(32)]) assert.match(ok, DEVICE_ID);
  for (const bad of ["", "-a", "A", "a_b", "a b", "a".repeat(33), "a/b", ".."]) assert.doesNotMatch(bad, DEVICE_ID);
  assert.deepEqual([...DEVICE_KINDS], ["local", "ssh", "exe-dev", "url"]);
});

test("dpiHome follows DPI_HOME and otherwise sits under the home directory", () => {
  const saved = process.env.DPI_HOME;
  try {
    process.env.DPI_HOME = "/custom/dpi";
    assert.equal(dpiHome(), "/custom/dpi");
    delete process.env.DPI_HOME;
    assert.match(dpiHome(), /[\\/]\.dpi$/);
  } finally {
    if (saved === undefined) delete process.env.DPI_HOME;
    else process.env.DPI_HOME = saved;
  }
});

test("a registry built without a path uses DPI_HOME and creates its directory privately", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-home-")));
  const saved = process.env.DPI_HOME;
  process.env.DPI_HOME = join(root, "nested", "home");
  try {
    const reg = new NetworkRegistry();
    try {
      assert.equal(reg.path, join(root, "nested", "home", "network.sqlite"));
      assert.equal((await stat(join(root, "nested", "home"))).mode & 0o777, 0o700);
      assert.equal((await stat(reg.path)).mode & 0o777, 0o600);
    } finally {
      reg.close();
    }
  } finally {
    if (saved === undefined) delete process.env.DPI_HOME;
    else process.env.DPI_HOME = saved;
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ rows

test("upsert defaults: name falls back to the id, kind to url, source to ui, position to the end", async () => {
  await withRegistry((reg) => {
    const first = reg.upsert({ id: "one", url: "http://one" });
    assert.deepEqual([first.name, first.kind, first.source, first.position, first.token], ["one", "url", "ui", 0, null]);
    assert.equal(reg.upsert({ id: "two", name: "   ", url: "http://two" }).name, "two", "a blank name is replaced by the id");
    assert.equal(reg.upsert({ id: "three", name: " Three ", url: "http://three" }).name, "Three");
    assert.deepEqual(reg.list().map((d) => [d.id, d.position]), [["one", 0], ["two", 1], ["three", 2]]);
    assert.equal(first.lastStatus, "checking");
    assert.ok(first.createdAt > 0 && first.updatedAt >= first.createdAt);
  });
});

test("upsert validates the kind, id, url and token; nothing is stored on failure", async () => {
  await withRegistry((reg) => {
    assert.throws(() => reg.upsert({ id: "a", url: "http://x", kind: "cloud" as never }), /Unknown device kind: cloud/);
    assert.throws(() => reg.upsert({ id: "", url: "http://x" }), /Device id must match/);
    assert.throws(() => reg.upsert({ id: "a", url: "http://x?q=1" }), /query or fragment/);
    assert.throws(() => reg.upsert({ id: "a", url: "http://x", token: "short" }), /32 characters/);
    assert.deepEqual(reg.list(), []);
  });
});

test("re-upserting keeps createdAt, bumps updatedAt, keeps the position and replaces the token only when given", async () => {
  await withRegistry(async (reg) => {
    const created = reg.upsert({ id: "d", url: "http://d", token: token("a"), position: 5 });
    await new Promise((r) => setTimeout(r, 5));
    const again = reg.upsert({ id: "d", name: "Renamed", url: "http://d" });
    assert.equal(again.createdAt, created.createdAt);
    assert.ok(again.updatedAt > created.updatedAt);
    assert.equal(again.position, 5);
    assert.equal(again.token, token("a"));
    assert.equal(reg.upsert({ id: "d", url: "http://d", token: token("b") }).token, token("b"));
    assert.equal(reg.upsert({ id: "d", url: "http://d", token: null }).token, null, "null clears the token");
    assert.equal(reg.upsert({ id: "d", url: "http://d", position: 1 }).position, 1);
  });
});

test("an unchanged url keeps the learned identity and cached status", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", url: "http://d" });
    reg.learnUid("d", "uid-1");
    reg.recordStatus("d", { status: "online", info: info(), tree: tree(), seenAt: 9 });
    reg.upsert({ id: "d", name: "Other", url: "http://d/" });
    const row = reg.get("d")!;
    assert.equal(row.deviceUid, "uid-1");
    assert.equal(row.lastStatus, "online");
    assert.ok(row.lastTree && row.lastInfo);
  });
});

test("setToken stores, clears and validates; an unknown device is an error", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", url: "http://d" });
    reg.setToken("d", token("c"));
    assert.equal(reg.get("d")!.token, token("c"));
    assert.throws(() => reg.setToken("d", "short"), /32 characters/);
    assert.equal(reg.get("d")!.token, token("c"), "a rejected token leaves the old one");
    reg.setToken("d", null);
    assert.equal(reg.get("d")!.token, null);
    assert.throws(() => reg.setToken("nope", token("c")), /Unknown device: nope/);
  });
});

test("remove reports whether a row went away; pruneConfig only touches config rows not in the keep list", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "cfg-keep", url: "http://a", source: "config" });
    reg.upsert({ id: "cfg-drop", url: "http://b", source: "config" });
    reg.upsert({ id: "ui-one", url: "http://c", source: "ui" });
    reg.pruneConfig(["cfg-keep"]);
    assert.deepEqual(reg.list().map((d) => d.id).sort(), ["cfg-keep", "ui-one"]);
    assert.equal(reg.remove("ui-one"), true);
    assert.equal(reg.remove("ui-one"), false);
    assert.equal(reg.get("ui-one"), undefined);
  });
});

test("list is ordered by position, then id", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "b", url: "http://b", position: 1 });
    reg.upsert({ id: "a", url: "http://a", position: 1 });
    reg.upsert({ id: "z", url: "http://z", position: 0 });
    assert.deepEqual(reg.list().map((d) => d.id), ["z", "a", "b"]);
  });
});

test("learnUid learns once and forgetUid resets it", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", url: "http://d" });
    reg.learnUid("d", "first");
    reg.learnUid("d", "second");
    assert.equal(reg.get("d")!.deviceUid, "first");
    reg.forgetUid("d");
    assert.equal(reg.get("d")!.deviceUid, null);
    reg.learnUid("d", "third");
    assert.equal(reg.get("d")!.deviceUid, "third");
  });
});

test("recordStatus stores status and error, and only the optional parts it is given", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", url: "http://d" });
    reg.recordStatus("d", { status: "online", seenAt: 100, info: info("i"), tree: tree("t") });
    let row = reg.get("d")!;
    assert.deepEqual([row.lastStatus, row.lastError, row.lastSeenAt, row.lastInfo?.uid, row.lastTree?.uid], ["online", null, 100, "i", "t"]);
    reg.recordStatus("d", { status: "offline", error: "refused" });
    row = reg.get("d")!;
    assert.deepEqual([row.lastStatus, row.lastError, row.lastSeenAt, row.lastInfo?.uid, row.lastTree?.uid], ["offline", "refused", 100, "i", "t"]);
    reg.recordStatus("d", { status: "online", error: null });
    assert.equal(reg.get("d")!.lastError, null);
    reg.recordStatus("missing", { status: "online" });
  });
});

test("corrupt cached JSON reads back as null instead of throwing", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", url: "http://d" });
    reg.db.prepare("UPDATE devices SET last_info_json=?, last_tree_json=? WHERE id=?").run("{not json", "", "d");
    const row = reg.get("d")!;
    assert.equal(row.lastInfo, null);
    assert.equal(row.lastTree, null);
  });
});

// ------------------------------------------------------------------ ui state

test("ui state round-trips JSON, overwrites by key and returns undefined for unknown or corrupt keys", async () => {
  await withRegistry((reg) => {
    assert.equal(reg.uiGet("nothing"), undefined);
    reg.uiSet("k", { a: [1, 2], b: null });
    assert.deepEqual(reg.uiGet("k"), { a: [1, 2], b: null });
    reg.uiSet("k", "now a string");
    assert.equal(reg.uiGet("k"), "now a string");
    reg.uiSet("zero", 0);
    assert.equal(reg.uiGet("zero"), 0);
    reg.uiSet("f", false);
    assert.equal(reg.uiGet("f"), false);
    reg.db.prepare("INSERT INTO ui_state(key,value,updated_at) VALUES('bad','{oops',1)").run();
    assert.equal(reg.uiGet("bad"), undefined);
  });
});

test("ui state refuses values over 100,000 characters and keeps the old value", async () => {
  await withRegistry((reg) => {
    reg.uiSet("big", "small");
    const justFits = "x".repeat(100_000 - 2);
    reg.uiSet("big", justFits);
    assert.equal((reg.uiGet<string>("big") ?? "").length, 99_998);
    assert.throws(() => reg.uiSet("big", "x".repeat(100_000 - 1)), /too large/);
    assert.equal((reg.uiGet<string>("big") ?? "").length, 99_998);
  });
});

// ------------------------------------------------------------------ persistence and public view

test("a registry reopened from the same file sees the earlier rows and ui state", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dpi-reg3-")));
  try {
    const path = join(dir, "n.sqlite");
    const first = new NetworkRegistry(path);
    first.upsert({ id: "d", url: "http://d", token: token("p") });
    first.uiSet("k", 1);
    first.close();
    const second = new NetworkRegistry(path);
    try {
      assert.equal(second.get("d")!.token, token("p"));
      assert.equal(second.uiGet("k"), 1);
      assert.equal((await stat(path)).mode & 0o777, 0o600, "reopening does not loosen the file mode");
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toPublic hides the token and lets live data override the cached row", async () => {
  await withRegistry((reg) => {
    reg.upsert({ id: "d", name: "Dee", kind: "ssh", url: "http://d", token: token("s"), source: "config" });
    reg.recordStatus("d", { status: "offline", error: "cached error", seenAt: 5, info: info("cached"), tree: tree("cached") });
    const row = reg.get("d")!;
    const cached = toPublic(row);
    assert.deepEqual(
      [cached.id, cached.name, cached.kind, cached.url, cached.source, cached.hasToken],
      ["d", "Dee", "ssh", "http://d", "config", true],
    );
    assert.deepEqual([cached.status, cached.error, cached.lastSeenAt, cached.info?.uid, cached.tree?.uid], ["offline", "cached error", 5, "cached", "cached"]);
    const live = toPublic(row, { status: "online", info: info("live"), tree: tree("live"), lastSeenAt: 77 });
    assert.deepEqual([live.status, live.error, live.lastSeenAt, live.info?.uid, live.tree?.uid], ["online", undefined, 77, "live", "live"]);
    const failing = toPublic(row, { status: "offline", error: "refused" });
    assert.deepEqual([failing.error, failing.lastSeenAt, failing.info?.uid], ["refused", 5, "cached"]);
    for (const view of [cached, live, failing]) assert.equal(JSON.stringify(view).includes(token("s")), false);
    reg.setToken("d", null);
    assert.equal(toPublic(reg.get("d")!).hasToken, false);
    assert.equal(toPublic({ ...row, lastSeenAt: null, lastInfo: null, lastTree: null, lastError: null }).lastSeenAt, undefined);
  });
});
