import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedFromConfig } from "../apps/dpi-playground-hub/src/seed.js";
import { newToken, tempDir, tempRegistry } from "./support.js";

// seedFromConfig reads DPI_NETWORK_FILE and the token variables from the environment: save and restore them.
const touched = ["DPI_NETWORK_FILE", "SEED_TOKEN_A", "SEED_TOKEN_B"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of touched) saved[k] = process.env[k];
  for (const k of touched) delete process.env[k];
});
afterEach(() => {
  for (const k of touched)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

const yaml = (body: string) => `devices:\n${body}`;
const device = (id: string, extra = "") =>
  `  ${id}:\n    kind: url\n    url: http://127.0.0.1:${4000 + id.length}\n${extra}`;

describe("seedFromConfig", () => {
  test("loads the devices into the registry as config devices, in file order, and returns the file", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(file, yaml(device("zeta") + device("alpha")));
      process.env.DPI_NETWORK_FILE = file;
      assert.equal(seedFromConfig(reg.registry, dir.dir), file);
      const rows = reg.registry.list();
      assert.deepEqual(
        rows.map((r) => r.id),
        ["zeta", "alpha"],
        "position follows the YAML, not the alphabet",
      );
      assert.ok(rows.every((r) => r.source === "config" && r.kind === "url" && r.token === null));
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("a device's token comes from the variable its token_env names", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(
        file,
        yaml(
          device("a", "    token_env: SEED_TOKEN_A\n") +
            device("b", "    token_env: SEED_TOKEN_B\n") +
            device("c"),
        ),
      );
      process.env.DPI_NETWORK_FILE = file;
      process.env.SEED_TOKEN_A = newToken();
      seedFromConfig(reg.registry, dir.dir); // SEED_TOKEN_B is not set
      assert.equal(reg.registry.get("a")!.token, process.env.SEED_TOKEN_A);
      assert.equal(
        reg.registry.get("b")!.token,
        null,
        "an unset variable leaves the device without a token",
      );
      assert.equal(reg.registry.get("c")!.token, null, "no token_env, no token");
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("seeding again keeps a token that was set with `just net register` when the variable is unset", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(file, yaml(device("a", "    token_env: SEED_TOKEN_A\n")));
      process.env.DPI_NETWORK_FILE = file;
      seedFromConfig(reg.registry, dir.dir);
      const registered = newToken();
      reg.registry.setToken("a", registered);
      seedFromConfig(reg.registry, dir.dir);
      assert.equal(reg.registry.get("a")!.token, registered);
      process.env.SEED_TOKEN_A = newToken();
      seedFromConfig(reg.registry, dir.dir);
      assert.equal(reg.registry.get("a")!.token, process.env.SEED_TOKEN_A, "a set variable wins");
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("a device dropped from the file is pruned, but one added through the UI source is not", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(file, yaml(device("keep") + device("drop")));
      process.env.DPI_NETWORK_FILE = file;
      seedFromConfig(reg.registry, dir.dir);
      reg.registry.upsert({ id: "manual", url: "http://127.0.0.1:1", source: "ui" });
      writeFileSync(file, yaml(device("keep")));
      seedFromConfig(reg.registry, dir.dir);
      assert.deepEqual(
        reg.registry
          .list()
          .map((r) => r.id)
          .sort(),
        ["keep", "manual"],
      );
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("a changed URL forgets what was learned about the old machine", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(file, yaml(device("a")));
      process.env.DPI_NETWORK_FILE = file;
      seedFromConfig(reg.registry, dir.dir);
      reg.registry.learnUid("a", "old-uid");
      writeFileSync(file, yaml("  a:\n    kind: url\n    url: http://127.0.0.1:9999\n"));
      seedFromConfig(reg.registry, dir.dir);
      assert.equal(reg.registry.get("a")!.url, "http://127.0.0.1:9999");
      assert.equal(reg.registry.get("a")!.deviceUid, null);
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("with no dpi-network.yaml anywhere above the start directory it returns undefined and adds nothing", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      mkdirSync(join(dir.dir, "deep", "er"), { recursive: true });
      assert.equal(seedFromConfig(reg.registry, join(dir.dir, "deep", "er")), undefined);
      assert.deepEqual(reg.registry.list(), []);
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("without DPI_NETWORK_FILE it finds the file by walking up from the start directory", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const nested = join(dir.dir, "apps", "dpi-playground");
      mkdirSync(nested, { recursive: true });
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(file, yaml(device("up")));
      assert.equal(seedFromConfig(reg.registry, nested), file);
      assert.deepEqual(
        reg.registry.list().map((r) => r.id),
        ["up"],
      );
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });

  test("an invalid file throws with the file name and the problem, and changes nothing", async () => {
    const dir = tempDir();
    const reg = tempRegistry();
    try {
      const file = join(dir.dir, "dpi-network.yaml");
      writeFileSync(
        file,
        yaml(device("fine") + "  Bad_Id:\n    kind: url\n    url: http://127.0.0.1:1\n"),
      );
      process.env.DPI_NETWORK_FILE = file;
      assert.throws(
        () => seedFromConfig(reg.registry, dir.dir),
        /dpi-network\.yaml: devices\.Bad_Id: id must match/,
      );
      assert.deepEqual(reg.registry.list(), []);
    } finally {
      await Promise.all([dir.cleanup(), reg.cleanup()]);
    }
  });
});
