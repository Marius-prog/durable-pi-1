import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const TOKEN = "t".repeat(40);

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dpi-config-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** An explicit env that never points at the real ~/.dpi. */
  const env = (extra: Record<string, string | undefined> = {}) => ({
    DPI_HOME: dir,
    DPI_TOKEN: TOKEN,
    ...extra,
  });

  test("defaults: loopback host, port 4780, data under DPI_HOME/backend, openrouter provider", () => {
    const c = loadConfig([], env());
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, 4780);
    assert.equal(c.home, dir);
    assert.equal(c.envFile, join(dir, "backend.env"));
    assert.equal(c.dataDir, join(dir, "backend"));
    assert.deepEqual(c.startDirs, [join(homedir(), "dpi-work")]);
    assert.equal(c.provider, "openrouter");
    assert.equal(c.token, TOKEN);
    assert.equal(c.name, hostname().replace(/\.local$/, ""));
  });

  test("environment variables override the defaults", () => {
    const c = loadConfig(
      [],
      env({
        DPI_DEVICE_NAME: "box",
        DPI_HOST: "0.0.0.0",
        DPI_PORT: "5001",
        DPI_DATA_DIR: join(dir, "elsewhere"),
        DPI_ENV_FILE: join(dir, "custom.env"),
        DPI_START_DIRS: `${join(dir, "a")}:${join(dir, "b")}`,
        DPI_PROVIDER: "faux",
      }),
    );
    assert.equal(c.name, "box");
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.port, 5001);
    assert.equal(c.dataDir, join(dir, "elsewhere"));
    assert.equal(c.envFile, join(dir, "custom.env"));
    assert.deepEqual(c.startDirs, [join(dir, "a"), join(dir, "b")]);
    assert.equal(c.provider, "faux");
  });

  test("flags win over the environment", () => {
    const c = loadConfig(
      ["--port", "6000", "--host", "10.0.0.5", "--name", "flagged", "--data-dir", join(dir, "d"), "--start-dirs", join(dir, "s"), "--env-file", join(dir, "f.env")],
      env({ DPI_PORT: "5001", DPI_HOST: "0.0.0.0", DPI_DEVICE_NAME: "envname", DPI_DATA_DIR: join(dir, "nope"), DPI_START_DIRS: join(dir, "nope2") }),
    );
    assert.equal(c.port, 6000);
    assert.equal(c.host, "10.0.0.5");
    assert.equal(c.name, "flagged");
    assert.equal(c.dataDir, join(dir, "d"));
    assert.deepEqual(c.startDirs, [join(dir, "s")]);
    assert.equal(c.envFile, join(dir, "f.env"));
  });

  test("a flag without a value, or followed by another flag, is an error", () => {
    assert.throws(() => loadConfig(["--port"], env()), /--port needs a value/);
    assert.throws(() => loadConfig(["--port", "--host", "x"], env()), /--port needs a value/);
    assert.throws(() => loadConfig(["--name", ""], env()), /--name needs a value/);
  });

  test("only the exact strings 'faux' select the faux provider", () => {
    assert.equal(loadConfig([], env({ DPI_PROVIDER: "faux" })).provider, "faux");
    assert.equal(loadConfig([], env({ DPI_PROVIDER: "openrouter" })).provider, "openrouter");
    assert.equal(loadConfig([], env({ DPI_PROVIDER: "FAUX" })).provider, "openrouter");
    assert.equal(loadConfig([], env({ DPI_PROVIDER: "something-else" })).provider, "openrouter");
  });

  test("ports outside 1-65535 and non-integers are rejected", () => {
    for (const port of ["0", "65536", "-1", "1.5", "abc", ""])
      assert.throws(() => loadConfig([], env({ DPI_PORT: port })), /Invalid port/, `port ${JSON.stringify(port)}`);
    assert.equal(loadConfig([], env({ DPI_PORT: "1" })).port, 1);
    assert.equal(loadConfig([], env({ DPI_PORT: "65535" })).port, 65535);
  });

  test("the token must be present and at least 32 characters, and the error names the env file", () => {
    assert.throws(() => loadConfig([], env({ DPI_TOKEN: undefined })), (e: Error) => /DPI_TOKEN is missing or shorter than 32/.test(e.message) && e.message.includes(join(dir, "backend.env")));
    assert.throws(() => loadConfig([], env({ DPI_TOKEN: "x".repeat(31) })), /shorter than 32/);
    assert.equal(loadConfig([], env({ DPI_TOKEN: "x".repeat(32) })).token, "x".repeat(32));
  });

  test("the token error never repeats the rejected value", () => {
    const secret = "short-secret-value";
    assert.throws(() => loadConfig([], env({ DPI_TOKEN: secret })), (e: Error) => !e.message.includes(secret));
  });

  test("~ expands to the home folder in DPI_HOME, data dir, env file and start dirs", () => {
    const c = loadConfig([], {
      DPI_HOME: "~/.dpi-test-never-created",
      DPI_TOKEN: TOKEN,
      DPI_DATA_DIR: "~/data-test-never-created",
      DPI_START_DIRS: "~:~/work-test-never-created",
    });
    assert.equal(c.home, join(homedir(), ".dpi-test-never-created"));
    assert.equal(c.envFile, join(homedir(), ".dpi-test-never-created", "backend.env"));
    assert.equal(c.dataDir, join(homedir(), "data-test-never-created"));
    assert.deepEqual(c.startDirs, [homedir(), join(homedir(), "work-test-never-created")]);
  });

  test("start dirs drop empty entries and resolve relative paths", () => {
    const c = loadConfig([], env({ DPI_START_DIRS: "::rel/dir::" }));
    assert.deepEqual(c.startDirs, [resolve("rel/dir")]);
  });

  test("an env file supplies values that are not already set, and a missing one is ignored", async () => {
    const file = join(dir, "backend.env");
    await writeFile(file, `DPI_TOKEN=${"e".repeat(40)}\nDPI_PORT=5555\nDPI_DEVICE_NAME=from-file\n`);
    const keys = ["DPI_TOKEN", "DPI_PORT", "DPI_DEVICE_NAME", "DPI_HOME", "DPI_ENV_FILE"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      process.env.DPI_HOME = dir;
      process.env.DPI_PORT = "4999"; // already set: the file never overrides it
      const c = loadConfig([], process.env);
      assert.equal(c.token, "e".repeat(40));
      assert.equal(c.port, 4999);
      assert.equal(c.name, "from-file");
      // Pointing at a file that does not exist is fine; the token check then reports it.
      delete process.env.DPI_TOKEN;
      assert.throws(() => loadConfig(["--env-file", join(dir, "missing.env")], process.env), /missing or shorter than 32/);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
