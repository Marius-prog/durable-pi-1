import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_START_DIR,
  MANAGED_ENV,
  NETWORK_FILE,
  loadNetworkConfig,
  parseNetworkConfig,
  syncConfigToRegistry,
  tryLoadNetworkConfig,
} from "../src/node/config.js";
import { NetworkRegistry } from "../src/node/registry.js";

async function tempDir(prefix: string) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Run `fn` with DPI_NETWORK_FILE and DPI_* env vars set the way the test needs, then restore them. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const yaml = "devices:\n  here:\n    kind: local\n";

test("loadNetworkConfig walks up from a nested directory to the nearest dpi-network.yaml", async () => {
  const root = await tempDir("dpi-net-");
  try {
    await mkdir(join(root, "a/b/c"), { recursive: true });
    await writeFile(join(root, NETWORK_FILE), yaml);
    await withEnv({ DPI_NETWORK_FILE: undefined }, async () => {
      const config = loadNetworkConfig(join(root, "a/b/c"));
      assert.equal(config.file, join(root, NETWORK_FILE));
      assert.equal(config.root, root);
      assert.deepEqual(Object.keys(config.devices), ["here"]);
      // A closer file wins over a farther one.
      await writeFile(join(root, "a", NETWORK_FILE), "devices:\n  nearer:\n    kind: local\n");
      assert.deepEqual(Object.keys(loadNetworkConfig(join(root, "a/b/c")).devices), ["nearer"]);
      assert.equal(tryLoadNetworkConfig(join(root, "a/b"))?.root, join(root, "a"));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DPI_NETWORK_FILE overrides the search, even for a directory with no file of its own", async () => {
  const root = await tempDir("dpi-net-");
  try {
    const custom = join(root, "elsewhere.yaml");
    await writeFile(custom, "devices:\n  custom:\n    kind: url\n    url: http://custom.test\n");
    await withEnv({ DPI_NETWORK_FILE: custom }, () => {
      const config = loadNetworkConfig(tmpdir());
      assert.equal(config.file, custom);
      assert.equal(config.root, root);
      assert.equal(config.devices.custom.url, "http://custom.test");
      assert.equal(tryLoadNetworkConfig()?.file, custom);
    });
    await withEnv({ DPI_NETWORK_FILE: join(root, "missing.yaml") }, () => {
      assert.throws(() => loadNetworkConfig(), /ENOENT/, "a named file that does not exist is an error, not 'no config'");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with no file anywhere, load throws a helpful error and tryLoad returns undefined", async (t) => {
  const root = await tempDir("dpi-net-empty-");
  try {
    let dir = root;
    while (true) {
      if (existsSync(join(dir, NETWORK_FILE))) return t.skip(`${join(dir, NETWORK_FILE)} exists above the temp dir`);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    await withEnv({ DPI_NETWORK_FILE: undefined }, () => {
      assert.throws(() => loadNetworkConfig(root), (e: unknown) => {
        const message = (e as Error).message;
        return message.includes(`No ${NETWORK_FILE} found from ${root}`) && message.includes("cp dpi-network.example.yaml");
      });
      assert.equal(tryLoadNetworkConfig(root), undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken file is reported with its own path in the message", async () => {
  const root = await tempDir("dpi-net-");
  try {
    const file = join(root, NETWORK_FILE);
    await writeFile(file, "devices:\n  a:\n    kind: cloud\n    url: http://x\n");
    await withEnv({ DPI_NETWORK_FILE: undefined }, () => {
      assert.throws(() => loadNetworkConfig(root), (e: unknown) => (e as Error).message.startsWith(`${file}: devices.a.kind must be one of`));
      assert.throws(() => tryLoadNetworkConfig(root), /kind must be one of/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ parseNetworkConfig

test("an empty or devices-less document parses to no devices; root is the file's directory", () => {
  assert.deepEqual(parseNetworkConfig("").devices, {});
  assert.deepEqual(parseNetworkConfig("# only a comment\n").devices, {});
  assert.deepEqual(parseNetworkConfig("defaults: { port: 1 }\n").devices, {});
  const config = parseNetworkConfig("", "/some/dir/my-net.yaml");
  assert.deepEqual([config.file, config.root], ["/some/dir/my-net.yaml", "/some/dir"]);
  assert.equal(parseNetworkConfig("").file, NETWORK_FILE);
  assert.throws(() => parseNetworkConfig("devices: [a, b]"), /devices must be a map/);
});

test("a kindless device and a bodiless device are rejected with the device named", () => {
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n"), /devices\.a\.kind must be a non-empty string/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    url: http://x"), /devices\.a\.kind must be a non-empty string/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: '  '\n    url: http://x"), /kind must be a non-empty string/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: 5"), /kind must be a non-empty string/);
});

test("ports: default 4780, per-device and default overrides, and range checks", () => {
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a.port, 4780);
  assert.equal(parseNetworkConfig("defaults: { port: 9000 }\ndevices:\n  a:\n    kind: local\n  b:\n    kind: local\n    port: 9100").devices.a.port, 9000);
  assert.equal(parseNetworkConfig("defaults: { port: 9000 }\ndevices:\n  a:\n    kind: local\n  b:\n    kind: local\n    port: 9100").devices.b.url, "http://127.0.0.1:9100");
  for (const bad of ["0", "65536", "1.5", "abc", "-1"])
    assert.throws(() => parseNetworkConfig(`devices:\n  a:\n    kind: local\n    port: ${bad}`), /\.port is invalid/, bad);
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local\n    port: 65535").devices.a.port, 65535);
});

test("optional fields: name, node, code_dir, home_dir, token_env and their defaults", () => {
  const plain = parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a;
  assert.deepEqual(
    [plain.name, plain.node, plain.codeDir, plain.homeDir, plain.tokenEnv, plain.envKeys, plain.env],
    ["a", 24, "~/dpi", "~/.dpi", undefined, [], {}],
  );
  const custom = parseNetworkConfig(
    "devices:\n  a:\n    kind: local\n    name: Alpha\n    node: 22\n    code_dir: /srv/dpi\n    home_dir: /srv/.dpi\n    token_env: A_TOKEN\n    env_keys: [KEY_ONE, KEY_TWO]",
  ).devices.a;
  assert.deepEqual(
    [custom.name, custom.node, custom.codeDir, custom.homeDir, custom.tokenEnv, custom.envKeys],
    ["Alpha", 22, "/srv/dpi", "/srv/.dpi", "A_TOKEN", ["KEY_ONE", "KEY_TWO"]],
  );
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local\n    name: 5").devices.a.name, "a", "a non-string name falls back to the id");
});

test("ssh devices need ssh and a service; exe-dev devices derive ssh, default to systemd and keep create hints", () => {
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    service: systemd\n    url: http://x"), /\.ssh must be a non-empty string/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: u@h\n    url: http://x\n    service: ''"), /launchd or systemd/);
  const ssh = parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: me@host\n    service: launchd\n    url: http://host:4780/").devices.a;
  assert.deepEqual([ssh.ssh, ssh.service, ssh.url, ssh.host], ["me@host", "launchd", "http://host:4780", "0.0.0.0"]);
  const exe = parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev\n    vm: dpi-box\n    create: { cpu: 4, memory: 8GB, disk: 40GB }").devices.vm;
  assert.deepEqual(exe.create, { cpu: 4, memory: "8GB", disk: "40GB" });
  assert.equal(parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev\n    vm: dpi-box").devices.vm.service, "systemd");
  assert.deepEqual(parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev\n    vm: dpi-box").devices.vm.create, {});
  assert.equal(parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev\n    vm: dpi-box\n    service: launchd").devices.vm.service, "launchd");
  assert.equal(parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev\n    vm: dpi-box\n    url: https://custom.example").devices.vm.url, "https://custom.example");
  for (const vm of ["A", "-bad", "x", "has_underscore", "a".repeat(64)])
    assert.throws(() => parseNetworkConfig(`devices:\n  vm:\n    kind: exe-dev\n    vm: ${vm}`), /not a valid exe\.dev name|must be a non-empty string/, vm);
  assert.throws(() => parseNetworkConfig("devices:\n  vm:\n    kind: exe-dev"), /\.vm must be a non-empty string/);
});

test("urls: kind url needs one, local derives it, and query strings or non-http schemes are refused", () => {
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: url\n    url: https://a.example///").devices.a.url, "https://a.example");
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: url\n    url: ftp://a.example"), /http or https/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: url\n    url: 'http://a.example/?x=1'"), /query or fragment/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: url\n    url: not-a-url"), /Invalid URL/);
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local\n    url: http://127.0.0.1:1234").devices.a.url, "http://127.0.0.1:1234", "an explicit url beats the derived one");
});

test("start_dirs and env_keys must be lists of strings; the default start dir is used when unset", () => {
  assert.deepEqual(parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a.startDirs, [DEFAULT_START_DIR]);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    start_dirs: ~/w"), /start_dirs must be a list of strings/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    start_dirs: [1]"), /start_dirs must be a list of strings/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: KEY"), /env_keys must be a list of strings/);
  assert.deepEqual(parseNetworkConfig("devices:\n  a:\n    kind: local\n    start_dirs: []").devices.a.startDirs, []);
});

test("env: accepts strings, numbers and booleans as strings; rejects bad names, values and shapes", () => {
  const env = (body: string) => parseNetworkConfig(`devices:\n  a:\n    kind: local\n    env: ${body}`).devices.a.env;
  assert.deepEqual(env("{ A_B: x, N: 5, T: true, F: false, S_2: '1.5' }"), { A_B: "x", N: "5", T: "true", F: "false", S_2: "1.5" });
  assert.throws(() => env("{ lower: x }"), /names are UPPER_SNAKE_CASE/);
  assert.throws(() => env("{ 1ABC: x }"), /names are UPPER_SNAKE_CASE/);
  assert.throws(() => env("{ A: [1] }"), /single-line string, number or boolean/);
  assert.throws(() => env("{ A: { b: 1 } }"), /single-line string, number or boolean/);
  assert.throws(() => env("{ A: null }"), /single-line string, number or boolean/);
  assert.throws(() => env('{ A: "two\\nlines" }'), /single-line/);
  assert.throws(() => env("[A, B]"), /env must be a map/);
  assert.throws(() => env("just-text"), /env must be a map/);
  for (const key of MANAGED_ENV) assert.throws(() => env(`{ ${key}: x }`), /is written from its own setting/, key);
  assert.throws(
    () => parseNetworkConfig("defaults:\n  env_keys: [SECRET]\ndevices:\n  a:\n    kind: local\n    env: { SECRET: x }"),
    /also in env_keys/,
    "defaults' env_keys apply to the device's env",
  );
  assert.throws(() => parseNetworkConfig("defaults:\n  env: { port: 1 }\ndevices:\n  a:\n    kind: local"), /defaults\.env\.port: names are UPPER_SNAKE_CASE/);
});

test("device settings override defaults, but a device env merges with the defaults' env", () => {
  const config = parseNetworkConfig(
    "defaults:\n  node: 20\n  service: systemd\n  env: { A: d, B: d }\ndevices:\n  one:\n    kind: ssh\n    ssh: h\n    url: http://h\n    node: 22\n    env: { B: own, C: own }\n  two:\n    kind: url\n    url: http://two",
  );
  assert.equal(config.devices.one.node, 22);
  assert.deepEqual(config.devices.one.env, { A: "d", B: "own", C: "own" });
  assert.equal(config.devices.two.node, 20);
  assert.equal(config.devices.two.service, "systemd", "defaults can set a service for any kind");
});

// ------------------------------------------------------------------ syncConfigToRegistry

test("sync keeps config order, copies a token from token_env, and refreshes changed urls", async () => {
  const dir = await tempDir("dpi-sync-");
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  const token = "dpi_" + "t".repeat(40);
  try {
    await withEnv({ SYNC_TEST_TOKEN: token, SYNC_TEST_UNSET: undefined }, () => {
      const text = (url: string) =>
        `devices:\n  zed:\n    kind: url\n    url: ${url}\n    token_env: SYNC_TEST_TOKEN\n  alpha:\n    kind: url\n    url: http://alpha\n    token_env: SYNC_TEST_UNSET\n    name: Alpha`;
      syncConfigToRegistry(parseNetworkConfig(text("http://zed.one")), reg);
      assert.deepEqual(reg.list().map((d) => d.id), ["zed", "alpha"], "position follows the file, not the id");
      assert.equal(reg.get("zed")!.token, token);
      assert.equal(reg.get("alpha")!.token, null, "an unset token_env leaves no token");
      assert.equal(reg.get("alpha")!.name, "Alpha");
      reg.setToken("alpha", "dpi_" + "a".repeat(40));
      syncConfigToRegistry(parseNetworkConfig(text("http://zed.two")), reg);
      assert.equal(reg.get("zed")!.url, "http://zed.two");
      assert.equal(reg.get("alpha")!.token, "dpi_" + "a".repeat(40), "a stored token survives a sync that has no token to offer");
    });
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync lets a config device take over the id of a UI device", async () => {
  const dir = await tempDir("dpi-sync-");
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  try {
    reg.upsert({ id: "dup", url: "http://ui.test", source: "ui" });
    syncConfigToRegistry(parseNetworkConfig("devices:\n  dup:\n    kind: url\n    url: http://cfg.test"), reg);
    const row = reg.get("dup")!;
    assert.deepEqual([row.source, row.url], ["config", "http://cfg.test"]);
    // Once it is a config device, the UI can no longer edit it.
    assert.throws(() => reg.upsert({ id: "dup", url: "http://ui.test", source: "ui" }), /dpi-network\.yaml/);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
