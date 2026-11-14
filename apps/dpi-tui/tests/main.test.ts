import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startFakeDevice, until, type FakeDevice } from "./support/fake-device.ts";
import { runMain, runToExit, scratch } from "./support/run-main.ts";

const TOKEN = "x".repeat(40);
const ESC = "\x1b";
const CTRL_C = "\x03";

async function withDevice(body: (device: FakeDevice, s: ReturnType<typeof scratch>) => Promise<void>) {
  const device = await startFakeDevice();
  const s = scratch();
  try {
    await body(device, s);
  } finally {
    s.cleanup();
    await device.close();
  }
}

/** Start the TUI, wait until it has opened both streams of an agent, press Ctrl+C and return how it ended. */
async function attach(device: FakeDevice, dir: string, args: string[], env: Record<string, string> = {}) {
  const agentStreams = () => device.requests.filter((r) => r.path.includes("/agents/") && r.path.endsWith("/events")).length;
  const sessionStreams = () => device.requests.filter((r) => /^\/v1\/sessions\/[^/]+\/events$/.test(r.path)).length;
  const [agentsBefore, sessionsBefore] = [agentStreams(), sessionStreams()];
  const running = runMain(dir, args, env);
  try {
    await until(() => agentStreams() > agentsBefore && sessionStreams() > sessionsBefore, `the TUI (${args.join(" ")}) to attach`, 10_000);
    await new Promise((r) => setTimeout(r, 250)); // let the tree and the first session frame arrive
    running.send(CTRL_C);
  } catch (e) {
    running.kill();
    const result = await running.done;
    throw new Error(`${(e as Error).message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return running.done;
}

// Each test starts its own processes, scratch directory and fake device, so they can run side by side.
describe("main.ts", { concurrency: 6 }, () => {
// ------------------------------------------------------------------ help and usage

test("--help and -h print the usage on stdout and exit 0", async () => {
  const s = scratch();
  try {
    for (const flag of ["--help", "-h"]) {
      const result = await runToExit(s.dir, [flag]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^usage: dpi-tui <device>\[:<session>\[:<agent>\]\] \[options\]/);
      for (const option of ["-s, --session", "-a, --agent", "--new <name>", "--cwd <dir>", "--model <id>", "--url, --token", "--save <id>"]) assert.ok(result.stdout.includes(option), option);
    }
  } finally {
    s.cleanup();
  }
});

test("no device and no URL prints the usage with the known devices and exits 1", async () => {
  const s = scratch();
  try {
    let result = await runToExit(s.dir, []);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^usage: dpi-tui/);
    assert.match(result.stderr, /Known devices: none$/m);

    s.registry.upsert({ id: "alpha", url: "https://alpha.test" });
    s.registry.upsert({ id: "beta", url: "https://beta.test" });
    result = await runToExit(s.dir, []);
    assert.match(result.stderr, /Known devices: alpha, beta$/m);
  } finally {
    s.cleanup();
  }
});

test("an unknown device names the ones that exist", async () => {
  const s = scratch();
  try {
    let result = await runToExit(s.dir, ["nope"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'Unknown device "nope". Known: none (add one to dpi-network.yaml)');
    s.registry.upsert({ id: "alpha", url: "https://alpha.test" });
    result = await runToExit(s.dir, ["nope:triage:main"]);
    assert.equal(result.stderr.trim(), 'Unknown device "nope". Known: alpha');
  } finally {
    s.cleanup();
  }
});

test("a device without a token says how to register one", async () => {
  const s = scratch();
  try {
    s.registry.upsert({ id: "alpha", url: "https://alpha.test" });
    const result = await runToExit(s.dir, ["alpha"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "No token for alpha. Run: just net register alpha");
  } finally {
    s.cleanup();
  }
});

test("--url needs a token, from --token or DPI_TOKEN", async () => {
  const s = scratch();
  try {
    const cases: [args: string[], env: Record<string, string>][] = [
      [["--url", "http://127.0.0.1:1"], {}],
      [[], { DPI_URL: "http://127.0.0.1:1" }],
    ];
    for (const [args, env] of cases) {
      const result = await runToExit(s.dir, args, env);
      assert.equal(result.code, 1);
      assert.equal(result.stderr.trim(), "--url needs --token (or DPI_TOKEN)");
    }
  } finally {
    s.cleanup();
  }
});

// ------------------------------------------------------------------ reaching the device

test("a device that is down is reported with its URL", async () => {
  const device = await startFakeDevice();
  const url = device.url;
  await device.close();
  const s = scratch();
  try {
    let result = await runToExit(s.dir, ["--url", url, "--token", TOKEN]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), `adhoc is offline at ${url} (Cannot reach ${url})`);

    s.registry.upsert({ id: "alpha", url, token: TOKEN });
    result = await runToExit(s.dir, ["alpha"]);
    assert.match(result.stderr, /^alpha is offline at /);
  } finally {
    s.cleanup();
  }
});

test("a rejected token is reported as such", async () => {
  await withDevice(async (device, s) => {
    device.injections.push({ match: (r) => r.path === "/v1/device", status: 401, code: "unauthorized", message: "bad token" });
    const result = await runToExit(s.dir, ["--url", device.url, "--token", TOKEN]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), `adhoc: token rejected by ${device.url}`);
  });
});

// ------------------------------------------------------------------ attaching

test("--url and --token with a session attach to its root agent; Ctrl+C exits and prints the reattach command", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["--url", device.url + "///", "--token", TOKEN, "-s", "triage"]);
    assert.equal(result.code, 0);
    assert.equal(device.seen("GET /v1/device").length, 1, "the device is probed once");
    assert.equal(device.seen("GET /v1/sessions/triage").length > 0, true);
    assert.ok(device.seen("GET /v1/sessions/11111111-aaaa-4aaa-8aaa-111111111111/agents/1/events").length > 0, "attached to the root agent");
    assert.match(result.stdout, /The agent keeps running on 127\.0\.0\.1:\d+\. Reattach:\s+just tui attach --url http:\/\/127\.0\.0\.1:\d+ --token <token> -s triage -a main/);
  });
});

test("-a picks an agent by name", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["--url", device.url, "--token", TOKEN, "-s", "triage", "-a", "alt-path"]);
    assert.equal(result.code, 0);
    assert.ok(device.seen("GET /v1/sessions/11111111-aaaa-4aaa-8aaa-111111111111/agents/2/events").length > 0);
    assert.match(result.stdout, /-s triage -a alt-path/);
  });
});

test("<device>:<session>:<agent> uses the registry's URL and token", async () => {
  await withDevice(async (device, s) => {
    s.registry.upsert({ id: "alpha", name: "Alpha", url: device.url, token: TOKEN });
    const result = await attach(device, s.dir, ["alpha:triage:alt-path"]);
    assert.equal(result.code, 0);
    assert.ok(device.seen("GET /v1/sessions/11111111-aaaa-4aaa-8aaa-111111111111/agents/2/events").length > 0);
    assert.match(result.stdout, /just tui attach alpha:triage:alt-path\s*$/);
  });
});

test("<device>:<session> attaches to the session's root agent", async () => {
  await withDevice(async (device, s) => {
    s.registry.upsert({ id: "alpha", url: device.url, token: TOKEN });
    const result = await attach(device, s.dir, ["alpha:review"]);
    assert.equal(result.code, 0);
    assert.ok(device.seen("GET /v1/sessions/22222222-bbbb-4bbb-8bbb-222222222222/agents/1/events").length > 0);
    assert.match(result.stdout, /just tui attach alpha:review:main/);
  });
});

test("a session or agent in the positional wins over -s and -a; the options fill what it leaves out", async () => {
  await withDevice(async (device, s) => {
    s.registry.upsert({ id: "alpha", url: device.url, token: TOKEN });
    let result = await attach(device, s.dir, ["alpha:review:main", "-s", "triage", "-a", "alt-path"]);
    assert.match(result.stdout, /just tui attach alpha:review:main/);
    result = await attach(device, s.dir, ["alpha", "-s", "triage", "-a", "alt-path"]);
    assert.match(result.stdout, /just tui attach alpha:triage:alt-path/);
  });
});

test("DPI_URL and DPI_TOKEN stand in for --url and --token", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["-s", "triage"], { DPI_URL: device.url, DPI_TOKEN: TOKEN });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--url http:\/\/127\.0\.0\.1:\d+ --token <token> -s triage -a main/);
  });
});

test("DPI_DEVICE names the default device, and a positional device wins over it", async () => {
  await withDevice(async (device, s) => {
    s.registry.upsert({ id: "alpha", url: device.url, token: TOKEN });
    s.registry.upsert({ id: "beta", url: "http://127.0.0.1:1", token: TOKEN });
    let result = await attach(device, s.dir, ["-s", "triage"], { DPI_DEVICE: "alpha" });
    assert.match(result.stdout, /just tui attach alpha:triage:main/);
    result = await attach(device, s.dir, ["alpha", "-s", "review"], { DPI_DEVICE: "beta" });
    assert.match(result.stdout, /just tui attach alpha:review:main/);
  });
});

test("without a session the picker opens, and Esc leaves", async () => {
  await withDevice(async (device, s) => {
    const running = runMain(s.dir, ["--url", device.url, "--token", TOKEN]);
    await until(() => device.seen("GET /v1/tree").length > 0, "the session list", 10_000);
    await new Promise((r) => setTimeout(r, 200));
    running.send(ESC);
    const result = await running.done;
    assert.equal(result.code, 0);
    assert.equal(device.openAgentStreams, 0, "no agent was attached");
    assert.doesNotMatch(result.stdout, /Reattach/);
    assert.match(result.stdout, /Sessions on adhoc|Sessions on 127/);
  });
});

test("--save stores a --url device in the registry", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["--url", device.url, "--token", TOKEN, "--save", "my-vm", "-s", "triage"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /just tui attach my-vm:triage:main/, "the saved id names the device");
    const db = new DatabaseSync(join(s.dir, "network.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT id, name, kind, url, token, source FROM devices WHERE id='my-vm'").get() as Record<string, string>;
      assert.deepEqual({ ...row }, { id: "my-vm", name: "my-vm", kind: "url", url: device.url, token: TOKEN, source: "ui" });
    } finally {
      db.close();
    }
  });
});

test("--save is ignored without --url, and a token too short to store stops it", async () => {
  await withDevice(async (device, s) => {
    s.registry.upsert({ id: "alpha", url: device.url, token: TOKEN });
    const result = await attach(device, s.dir, ["alpha:triage", "--save", "copy"]);
    assert.equal(result.code, 0);
    assert.equal(s.registry.get("copy"), undefined);

    const bad = await runToExit(s.dir, ["--url", device.url, "--token", "short", "--save", "my-vm"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Token must be at least 32 characters/);
    assert.equal(s.registry.get("my-vm"), undefined);
  });
});

// ------------------------------------------------------------------ --new

test("--new creates a session in the device's first start dir with its default model and attaches", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["--url", device.url, "--token", TOKEN, "--new", "fresh"]);
    assert.equal(result.code, 0);
    const [create] = device.seen("POST /v1/sessions");
    assert.deepEqual(create.body, { name: "fresh", cwd: "/work", model: { provider: "faux", modelId: "beta-2" } });
    assert.ok(create.idempotencyKey, "creation is idempotent");
    assert.deepEqual(device.seen("GET /v1/fs/dirs").map((r) => r.path), ["/v1/fs/dirs?path="]);
    assert.match(result.stdout, /-s fresh -a main/);
  });
});

test("--new with --cwd and --model uses them without listing directories", async () => {
  await withDevice(async (device, s) => {
    const result = await attach(device, s.dir, ["--url", device.url, "--token", TOKEN, "--new", "custom", "--cwd", "/work/app", "--model", "alpha-1"]);
    assert.equal(result.code, 0);
    assert.deepEqual(device.seen("POST /v1/sessions")[0].body, { name: "custom", cwd: "/work/app", model: { provider: "faux", modelId: "alpha-1" } });
    assert.equal(device.seen("GET /v1/fs/dirs").length, 0);
  });
});

test("--new with an unknown model lists the available ones and creates nothing", async () => {
  await withDevice(async (device, s) => {
    const result = await runToExit(s.dir, ["--url", device.url, "--token", TOKEN, "--new", "x", "--model", "gpt-nope"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "Unknown model gpt-nope. Available: alpha-1, beta-2");
    assert.equal(device.seen("POST /v1/sessions").length, 0);
  });
});

test("--new on a device with no start dirs asks for --cwd", async () => {
  await withDevice(async (device, s) => {
    device.dirs[""] = { path: "", dirs: [] };
    const result = await runToExit(s.dir, ["--url", device.url, "--token", TOKEN, "--new", "x"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "adhoc has no start dirs; pass --cwd");
    assert.equal(device.seen("POST /v1/sessions").length, 0);
  });
});

test("--new reports a failed creation", async () => {
  await withDevice(async (device, s) => {
    device.injections.push({ match: (r) => r.method === "POST" && r.path === "/v1/sessions", status: 400, code: "invalid", message: "cwd does not exist" });
    const result = await runToExit(s.dir, ["--url", device.url, "--token", TOKEN, "--new", "x", "--cwd", "/nowhere"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "Could not create the session: cwd does not exist");
  });
});

// ------------------------------------------------------------------ dpi-network.yaml

test("devices from dpi-network.yaml in the working directory are known, with tokens from token_env", async () => {
  await withDevice(async (device, s) => {
    writeFileSync(
      join(s.dir, "dpi-network.yaml"),
      `devices:\n  tester:\n    kind: url\n    url: ${device.url}\n    token_env: DPI_TEST_TOKEN\n  tokenless:\n    kind: url\n    url: ${device.url}\n`,
    );
    const result = await attach(device, s.dir, ["tester:triage"], { DPI_TEST_TOKEN: TOKEN });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /just tui attach tester:triage:main/);

    const missing = await runToExit(s.dir, ["tokenless"], { DPI_TEST_TOKEN: TOKEN });
    assert.equal(missing.stderr.trim(), "No token for tokenless. Run: just net register tokenless");
    const listed = await runToExit(s.dir, [], {});
    assert.match(listed.stderr, /Known devices: tester, tokenless$/m);
  });
});
});
