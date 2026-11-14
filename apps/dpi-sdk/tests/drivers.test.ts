import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SERVICE_LABEL, SYSTEMD_UNIT, defaultHome, drivers, q, waitOnline, type DriverContext } from "../src/node/drivers.js";
import { SSH_OPTS, shPath } from "../src/node/ops.js";
import { parseNetworkConfig, type NetDevice } from "../src/node/config.js";
import { NetworkRegistry } from "../src/node/registry.js";
import { installStubs, type StubRule, type Stubs } from "./helpers/stub-bin.js";

// Everything here is offline. Remote commands go to stub `ssh`/`rsync` programs on PATH (see helpers/stub-bin.ts);
// the local driver runs real `sh` against a temp HOME; the device answers through a stubbed fetch.

const TOKEN = "dpi_" + "k".repeat(43);
const SECRET = "sekret-api-key-value-0123456789";
const templates = new URL("../../dpi-backend/deploy/", import.meta.url);

interface Fixture {
  stubs: Stubs;
  ctx: DriverContext;
  logs: string[];
  root: string;
  device: (id: string) => NetDevice;
  dispose(): Promise<void>;
}

async function fixture(yaml: string, dotenv?: string, args: string[] = []): Promise<Fixture> {
  const stubs = await installStubs();
  const root = join(stubs.dir, "checkout");
  await mkdir(join(root, "apps/dpi-backend/deploy"), { recursive: true });
  for (const file of ["dpi-backend.plist", "dpi-backend.service"])
    await copyFile(new URL(file, templates), join(root, "apps/dpi-backend/deploy", file));
  if (dotenv !== undefined) await writeFile(join(root, ".env"), dotenv);
  const config = parseNetworkConfig(yaml, join(root, "dpi-network.yaml"));
  const registry = new NetworkRegistry(join(stubs.dir, "network.sqlite"));
  const logs: string[] = [];
  return {
    stubs,
    root,
    logs,
    ctx: { config, registry, args, log: (line) => void logs.push(line) },
    device: (id) => config.devices[id],
    async dispose() {
      registry.close();
      await stubs.dispose();
    },
  };
}

const FACTS: StubRule = {
  match: "NODE=\\$\\(nvm which",
  stdout: "HOME=/home/dpi\nUSER=dpi\nNODE=/home/dpi/.nvm/versions/node/v24.1.0/bin/node\n",
};
const REGISTER_TOKEN: StubRule = { match: 'backend\\.env" \\| head -1 \\| cut -d= -f2-', stdout: TOKEN + "\n" };

const SSH_YAML = `
devices:
  box:
    kind: ssh
    ssh: dpi@box.invalid
    service: systemd
    url: http://box.invalid:4780
    env_keys: [DPI_TEST_SECRET, DPI_TEST_MISSING]
    env: { DPI_PROVIDER: faux }
    start_dirs: ['~/work', '/srv/data']
  mac:
    kind: ssh
    ssh: me@mac.invalid
    service: launchd
    url: http://mac.invalid:4780
  vm:
    kind: exe-dev
    vm: dpi-test-vm
    create: { cpu: 2, memory: 4GB, disk: 20GB }
`;

/** Replace globalThis.fetch for the duration of a test. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
const deviceInfoResponse = () =>
  new Response(JSON.stringify({ name: "box", uid: "uid-1", models: [{}, {}] }), { status: 200, headers: { "content-type": "application/json" } });

async function captureStdout<T>(marker: string, fn: () => Promise<T>) {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (text.includes(marker)) return captured.push(text) > 0;
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), captured: captured.join("") };
  } finally {
    process.stdout.write = original;
  }
}

async function withProcessEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------------------ the verb tables

test("each device kind offers exactly the verbs it can honour", () => {
  const verbs = (kind: keyof typeof drivers) => Object.keys(drivers[kind]).sort();
  assert.deepEqual(verbs("url"), ["register", "up"]);
  assert.deepEqual(verbs("local"), ["down", "env", "logs", "register", "restart", "rotate", "service", "up"]);
  assert.deepEqual(verbs("ssh"), ["deploy", "down", "env", "logs", "provision", "register", "restart", "rotate", "service", "up"]);
  assert.deepEqual(verbs("exe-dev"), [...verbs("ssh"), "create", "destroy", "expose"].sort());
  // Only exe.dev VMs can be created, exposed or destroyed: no other kind may carry those verbs.
  for (const kind of ["url", "local", "ssh"] as const)
    for (const verb of ["create", "expose", "destroy"] as const) assert.equal(drivers[kind][verb], undefined, `${kind}.${verb}`);
  assert.equal(drivers.local.deploy, undefined, "a local device runs this checkout, so there is nothing to deploy");
  assert.equal(drivers.local.provision, undefined);
});

test("exports: service names, defaultHome and the q re-export", () => {
  assert.equal(SERVICE_LABEL, "dev.dpi.backend");
  assert.equal(SYSTEMD_UNIT, "dpi-backend");
  assert.equal(defaultHome(), homedir());
  assert.equal(q("a'b"), `'a'\\''b'`);
});

// ------------------------------------------------------------------ waitOnline

test("waitOnline returns the device info once the device answers, using the registry token", async () => {
  const fx = await fixture(SSH_YAML);
  const fetchStub = stubFetch(() => deviceInfoResponse());
  try {
    fx.ctx.registry.upsert({ id: "box", url: "http://box.invalid:4780", token: TOKEN, source: "config" });
    const info = await waitOnline(fx.device("box"), fx.ctx);
    assert.equal(info.uid, "uid-1");
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, "http://box.invalid:4780/v1/device");
    assert.equal(fetchStub.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(fx.logs, ["online box: http://box.invalid:4780 (box, uid uid-1, 2 models)"]);
  } finally {
    fetchStub.restore();
    await fx.dispose();
  }
});

test("waitOnline needs a stored token and says how to get one", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await assert.rejects(waitOnline(fx.device("box"), fx.ctx), /box has no token; run: just net register box/);
    fx.ctx.registry.upsert({ id: "box", url: "http://box.invalid:4780", source: "config" });
    await assert.rejects(waitOnline(fx.device("box"), fx.ctx), /has no token/);
  } finally {
    await fx.dispose();
  }
});

test("waitOnline gives up at its deadline and reports the last failure", async () => {
  const fx = await fixture(SSH_YAML);
  const fetchStub = stubFetch(() => {
    throw new TypeError("connect ECONNREFUSED");
  });
  try {
    fx.ctx.registry.upsert({ id: "box", url: "http://box.invalid:4780", token: TOKEN, source: "config" });
    // A deadline of 0 never tries at all.
    await assert.rejects(waitOnline(fx.device("box"), fx.ctx, 0), /box did not come online at http:\/\/box\.invalid:4780: $/);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    await fx.dispose();
  }
});

test("waitOnline retries every 2s after a failure and succeeds when the device appears", async () => {
  const fx = await fixture(SSH_YAML);
  let attempts = 0;
  const fetchStub = stubFetch(() => {
    attempts++;
    return attempts < 3 ? new Response("starting", { status: 503, statusText: "Service Unavailable" }) : deviceInfoResponse();
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    fx.ctx.registry.upsert({ id: "box", url: "http://box.invalid:4780", token: TOKEN, source: "config" });
    const pending = waitOnline(fx.device("box"), fx.ctx);
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
    };
    await settle();
    assert.equal(attempts, 1);
    mock.timers.tick(1_999);
    await settle();
    assert.equal(attempts, 1, "still inside the 2s pause");
    mock.timers.tick(1);
    await settle();
    assert.equal(attempts, 2);
    mock.timers.tick(2_000);
    await settle();
    assert.equal((await pending).uid, "uid-1");
    assert.equal(attempts, 3);
  } finally {
    mock.timers.reset();
    fetchStub.restore();
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ url driver

test("url driver register takes --token, then the device's token_env, and refuses to guess", async () => {
  const fx = await fixture(
    "devices:\n  web:\n    kind: url\n    url: http://web.invalid\n    token_env: DPI_TEST_WEB_TOKEN\n  bare:\n    kind: url\n    url: http://bare.invalid\n",
  );
  try {
    const register = drivers.url.register!;
    await withProcessEnv({ DPI_TEST_WEB_TOKEN: undefined }, async () => {
      await assert.rejects(register(fx.device("web"), fx.ctx), /web is a url device: pass --token <token> or set DPI_TEST_WEB_TOKEN/);
      await assert.rejects(register(fx.device("bare"), fx.ctx), (e: unknown) => (e as Error).message.endsWith("pass --token <token>"));
    });
    // syncConfigToRegistry ran first, so the rows exist even though no token was found.
    assert.deepEqual(fx.ctx.registry.list().map((d) => d.id), ["web", "bare"]);
    fx.ctx.args = ["--token", TOKEN];
    await register(fx.device("web"), fx.ctx);
    assert.equal(fx.ctx.registry.get("web")!.token, TOKEN);
    assert.deepEqual(fx.logs.at(-1), "register web: token stored");
    fx.ctx.registry.learnUid("web", "old");
    fx.ctx.args = [];
    await withProcessEnv({ DPI_TEST_WEB_TOKEN: "dpi_" + "e".repeat(40) }, () => register(fx.device("web"), fx.ctx));
    assert.equal(fx.ctx.registry.get("web")!.token, "dpi_" + "e".repeat(40));
    assert.equal(fx.ctx.registry.get("web")!.deviceUid, null, "registering forgets the learned uid");
    fx.ctx.args = ["--token", "short"];
    await assert.rejects(register(fx.device("web"), fx.ctx), /32 characters/);
  } finally {
    await fx.dispose();
  }
});

test("url driver up registers, then waits for the device", async () => {
  const fx = await fixture("devices:\n  web:\n    kind: url\n    url: http://web.invalid\n", undefined, ["--token", TOKEN]);
  const fetchStub = stubFetch(() => deviceInfoResponse());
  try {
    await drivers.url.up!(fx.device("web"), fx.ctx);
    assert.equal(fetchStub.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(fx.logs.map((l) => l.split(":")[0]), ["register web", "online web"]);
  } finally {
    fetchStub.restore();
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ ssh driver: env and secrets

test("env: the script travels on stdin with the settings and secrets, and argv carries none of it", async () => {
  const fx = await fixture(SSH_YAML, `# local secrets\nDPI_TEST_SECRET="${SECRET}"\nUNRELATED=1\n`);
  try {
    await drivers.ssh.env!(fx.device("box"), fx.ctx);
    const [call] = await fx.stubs.calls();
    assert.deepEqual(call.args, [...SSH_OPTS, "dpi@box.invalid", "sh -s"]);
    assert.equal(call.args.join(" ").includes(SECRET), false);
    const body = call.stdin.split("<<'DPI_ENV_EOF'\n")[1].split("\nDPI_ENV_EOF")[0].split("\n");
    assert.deepEqual(body, [
      "DPI_DEVICE_NAME=box",
      "DPI_PORT=4780",
      "DPI_HOST=0.0.0.0",
      "DPI_START_DIRS=~/work:/srv/data",
      `DPI_TEST_SECRET=${SECRET}`,
      "DPI_PROVIDER=faux",
    ]);
    assert.match(call.stdin, /umask 077/);
    assert.match(call.stdin, /mkdir -p "\$HOME\/\.dpi"/);
    assert.match(call.stdin, /mkdir -p "\$HOME\/work"\nmkdir -p "\/srv\/data"/);
    assert.match(call.stdin, /\[ "0" = 1 \]/, "an ordinary env write keeps the token");
    assert.match(call.stdin, /chmod 600 "\$F"/);
    assert.deepEqual(
      fx.logs,
      ["warning: DPI_TEST_MISSING not found in " + join(fx.root, ".env") + " or the environment", "env box: ~/.dpi/backend.env written (token kept or created)"],
    );
    assert.equal(fx.logs.join("\n").includes(SECRET), false, "secret values are never logged");
  } finally {
    await fx.dispose();
  }
});

test("env falls back to the process environment, drops multi-line values and strips .env quotes", async () => {
  const yaml = `devices:
  one:
    kind: ssh
    ssh: h
    service: systemd
    url: http://h
    env_keys: [QUOTED, SINGLE, EXPORTED, SPACED, EMPTY, FROM_PROC, MULTILINE, UNSET]
`;
  const dotenv = [
    "# comment",
    "",
    'QUOTED="double quoted"',
    "SINGLE='single quoted'",
    "export EXPORTED=exported-value",
    "SPACED = spaced value",
    "EMPTY=",
    "not a line",
    "9BAD=1",
  ].join("\n");
  const fx = await fixture(yaml, dotenv);
  try {
    await withProcessEnv({ FROM_PROC: "from-process", MULTILINE: "a\nb", UNSET: undefined }, () => drivers.ssh.env!(fx.device("one"), fx.ctx));
    const [call] = await fx.stubs.calls();
    const body = call.stdin.split("<<'DPI_ENV_EOF'\n")[1].split("\nDPI_ENV_EOF")[0].split("\n");
    assert.deepEqual(body.slice(4), [
      "QUOTED=double quoted",
      "SINGLE=single quoted",
      "EXPORTED=exported-value",
      "SPACED=spaced value",
      "FROM_PROC=from-process",
    ]);
    assert.match(fx.logs[0], /^warning: EMPTY, UNSET not found in /, "an empty value counts as missing; a multi-line one is dropped without a warning");
  } finally {
    await fx.dispose();
  }
});

test("a checkout with no .env still writes the env, warning about every key", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await withProcessEnv({ DPI_TEST_SECRET: undefined }, () => drivers.ssh.env!(fx.device("box"), fx.ctx));
    assert.match(fx.logs[0], /^warning: DPI_TEST_SECRET, DPI_TEST_MISSING not found/);
    const [call] = await fx.stubs.calls();
    assert.equal(call.stdin.includes("DPI_TEST_SECRET="), false);
  } finally {
    await fx.dispose();
  }
});

test("rotate rewrites the env with a forced new token, restarts the service and registers the new token", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([REGISTER_TOKEN]);
    await drivers.ssh.rotate!(fx.device("box"), fx.ctx);
    const calls = await fx.stubs.calls();
    assert.equal(calls.length, 3);
    assert.match(calls[0].stdin, /\[ "1" = 1 \]/, "rotate forces a new token");
    assert.match(calls[1].stdin, /sudo -n systemctl restart dpi-backend/);
    assert.match(calls[2].stdin, /grep '\^DPI_TOKEN=' "\$HOME\/\.dpi\/backend\.env"/);
    assert.equal(fx.ctx.registry.get("box")!.token, TOKEN);
    assert.ok(fx.logs.some((l) => l.includes("token rotated")));
  } finally {
    await fx.dispose();
  }
});

test("register stores the token read from the device and forgets the old uid; an empty file is explained", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await assert.rejects(drivers.ssh.register!(fx.device("box"), fx.ctx), /box: no DPI_TOKEN in ~\/\.dpi\/backend\.env; run: just net step env box/);
    await fx.stubs.rules([REGISTER_TOKEN]);
    fx.ctx.registry.upsert({ id: "box", url: "http://box.invalid:4780", source: "config" });
    fx.ctx.registry.learnUid("box", "stale-uid");
    await drivers.ssh.register!(fx.device("box"), fx.ctx);
    const row = fx.ctx.registry.get("box")!;
    assert.deepEqual([row.token, row.deviceUid], [TOKEN, null]);
    assert.ok(fx.logs.at(-1)!.startsWith("register box: token stored in "));
  } finally {
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ ssh driver: provision, deploy, service

test("provision installs nvm and node; only exe.dev VMs also run apt", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([{ match: "nvm install 24", stdout: "node: /home/dpi/.nvm/versions/node/v24/bin/node\n" }]);
    await drivers.ssh.provision!(fx.device("box"), fx.ctx);
    await drivers["exe-dev"].provision!(fx.device("vm"), fx.ctx);
    const [plain, vm] = await fx.stubs.calls();
    for (const call of [plain, vm]) {
      assert.match(call.stdin, /nvm-sh\/nvm\/v0\.40\.3\/install\.sh/);
      assert.match(call.stdin, /nvm install 24/);
    }
    assert.equal(plain.stdin.includes("apt-get"), false);
    assert.match(vm.stdin, /sudo -n apt-get update/);
    assert.match(vm.stdin, /install -y -qq git rsync curl build-essential ripgrep/);
    assert.deepEqual(fx.logs, [
      "provision box: nvm + node 24",
      "node: /home/dpi/.nvm/versions/node/v24/bin/node",
      "provision vm: nvm + node 24",
      "node: /home/dpi/.nvm/versions/node/v24/bin/node",
    ]);
  } finally {
    await fx.dispose();
  }
});

test("deploy makes the directories, rsyncs backend and sdk from the checkout, then runs npm ci remotely", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await drivers.ssh.deploy!(fx.device("box"), fx.ctx);
    const calls = await fx.stubs.calls();
    assert.deepEqual(calls.map((c) => c.cmd), ["ssh", "rsync", "ssh"]);
    assert.match(calls[0].stdin, /mkdir -p "\$HOME\/dpi\/apps" "\$HOME\/dpi\/e2e" "\$HOME\/\.dpi" && chmod 700 "\$HOME\/\.dpi"/);
    assert.deepEqual(calls[1].args.slice(-3), ["apps/dpi-backend", "apps/dpi-sdk", "dpi@box.invalid:dpi/apps/"]);
    assert.match(calls[2].stdin, /cd "\$HOME\/dpi\/apps\/dpi-backend" && nvm exec 24 npm ci --no-audit --no-fund/);
    assert.deepEqual(fx.logs, ["deploy box: sync apps/dpi-backend + apps/dpi-sdk → ~/dpi/apps", "deploy box: npm ci"]);
  } finally {
    await fx.dispose();
  }
});

test("service installs a rendered systemd unit with every placeholder filled", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([FACTS]);
    await drivers.ssh.service!(fx.device("box"), fx.ctx);
    const [, install] = await fx.stubs.calls();
    const unit = install.stdin.split("<<'DPI_UNIT_EOF'\n")[1].split("\nDPI_UNIT_EOF")[0];
    assert.equal(unit.includes("__"), false, "no placeholder is left in the unit");
    assert.match(unit, /^User=dpi$/m);
    assert.match(unit, /^WorkingDirectory=\/home\/dpi\/dpi\/apps\/dpi-backend$/m);
    assert.match(unit, /^ExecStart=\/home\/dpi\/\.nvm\/versions\/node\/v24\.1\.0\/bin\/node \/home\/dpi\/dpi\/apps\/dpi-backend\/node_modules\/tsx\/dist\/cli\.mjs src\/main\.ts$/m);
    assert.match(unit, /^Environment=PATH=\/home\/dpi\/\.nvm\/versions\/node\/v24\.1\.0\/bin:\/opt\/homebrew\/bin:/m);
    assert.match(unit, /^Environment=HOME=\/home\/dpi$/m);
    assert.match(unit, /^Environment=DPI_HOME=\/home\/dpi\/\.dpi$/m);
    assert.match(unit, /^StandardOutput=append:\/home\/dpi\/\.dpi\/backend\.log$/m);
    assert.match(install.stdin, /sudo -n tee \/etc\/systemd\/system\/dpi-backend\.service/);
    assert.match(install.stdin, /sudo -n systemctl enable dpi-backend[\s\S]*sudo -n systemctl restart dpi-backend/);
    assert.equal(fx.logs.at(-1), "service box: systemd installed and started");
  } finally {
    await fx.dispose();
  }
});

test("service installs a rendered launchd plist and reloads the agent", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([FACTS]);
    await drivers.ssh.service!(fx.device("mac"), fx.ctx);
    const [, install] = await fx.stubs.calls();
    const plist = install.stdin.split("<<'DPI_PLIST_EOF'\n")[1].split("\nDPI_PLIST_EOF")[0];
    assert.equal(plist.includes("__"), false);
    assert.match(plist, /<key>Label<\/key><string>dev\.dpi\.backend<\/string>/);
    assert.match(plist, /<string>\/home\/dpi\/\.nvm\/versions\/node\/v24\.1\.0\/bin\/node<\/string>/);
    assert.match(plist, /<key>DPI_HOME<\/key><string>\/home\/dpi\/\.dpi<\/string>/);
    assert.match(install.stdin, /launchctl bootout gui\/\$\(id -u\)\/dev\.dpi\.backend/);
    assert.match(install.stdin, /launchctl bootstrap gui\/\$\(id -u\) "\$P"/);
    assert.match(install.stdin, /Library\/LaunchAgents\/dev\.dpi\.backend\.plist/);
    assert.equal(fx.logs.at(-1), "service mac: launchd installed and started");
  } finally {
    await fx.dispose();
  }
});

test("service explains a missing node, a missing service setting and a missing template", async () => {
  const fx = await fixture(SSH_YAML + "  nosvc:\n    kind: url\n    url: http://n.invalid\n");
  try {
    await assert.rejects(drivers.ssh.service!(fx.device("nosvc"), fx.ctx), /nosvc has no service in dpi-network\.yaml/);
    await fx.stubs.rules([{ match: "NODE=\\$\\(nvm which", stdout: "HOME=/home/dpi\nUSER=dpi\nNODE=\n" }]);
    await assert.rejects(drivers.ssh.service!(fx.device("box"), fx.ctx), /box: node 24 not found; run: just net step provision box/);
  } finally {
    await fx.dispose();
  }
});

test("restart and down use the service manager the device declares", async () => {
  const fx = await fixture(SSH_YAML + "  nosvc:\n    kind: url\n    url: http://n.invalid\n");
  try {
    await drivers.ssh.restart!(fx.device("box"), fx.ctx);
    await drivers.ssh.down!(fx.device("box"), fx.ctx);
    await drivers.ssh.restart!(fx.device("mac"), fx.ctx);
    await drivers.ssh.down!(fx.device("mac"), fx.ctx);
    const scripts = (await fx.stubs.calls()).map((c) => c.stdin.split("\n").slice(4).join("\n"));
    assert.deepEqual(scripts, [
      "sudo -n systemctl restart dpi-backend",
      "sudo -n systemctl stop dpi-backend",
      "launchctl kickstart -k gui/$(id -u)/dev.dpi.backend",
      "launchctl bootout gui/$(id -u)/dev.dpi.backend 2>/dev/null || true",
    ]);
    assert.deepEqual(fx.logs, ["restart box: done", "down box: stopped", "restart mac: done", "down mac: stopped"]);
    await assert.rejects(drivers.ssh.restart!(fx.device("nosvc"), fx.ctx), /nosvc has no service; it runs with `just backend run`/);
    await assert.rejects(drivers.ssh.down!(fx.device("nosvc"), fx.ctx), /has no service/);
  } finally {
    await fx.dispose();
  }
});

test("logs tails the device's log: 80 lines by default, N when asked, and 80 again for nonsense", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([{ match: "tail -n", stdout: "LOGLINE-MARKER one\n" }]);
    const run = (args: string[]) => {
      fx.ctx.args = args;
      return captureStdout("LOGLINE-MARKER", () => drivers.ssh.logs!(fx.device("box"), fx.ctx));
    };
    assert.equal((await run([])).captured, "LOGLINE-MARKER one\n");
    await run(["5"]);
    await run(["abc"]);
    await run(["0"]);
    const tails = (await fx.stubs.calls()).map((c) => c.stdin.match(/tail -n (\d+) "\$HOME\/\.dpi\/backend\.log"/)?.[1]);
    assert.deepEqual(tails, ["80", "5", "80", "80"]);
  } finally {
    await fx.dispose();
  }
});

test("up on an ssh device runs every step in order and ends with the device online", async () => {
  const fx = await fixture(SSH_YAML);
  const fetchStub = stubFetch(() => deviceInfoResponse());
  try {
    await fx.stubs.rules([FACTS, REGISTER_TOKEN, { match: "nvm install 24", stdout: "node: /n\n" }]);
    await drivers.ssh.up!(fx.device("box"), fx.ctx);
    const phases = fx.logs.map((l) => l.match(/^(provision|deploy|env|service|register|online|warning)/)?.[1]).filter(Boolean);
    assert.deepEqual([...new Set(phases)], ["provision", "deploy", "warning", "env", "service", "register", "online"]);
    assert.equal(fx.ctx.registry.get("box")!.token, TOKEN);
    assert.equal(fetchStub.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    fetchStub.restore();
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ exe.dev driver

const vmList = (...names: string[]): StubRule => ({ match: "exe\\.dev ls --json", stdout: JSON.stringify({ vms: names.map((n) => ({ vm_name: n })) }) });

test("create leaves an existing VM alone and waits for ssh", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([vmList("dpi-test-vm"), { match: "echo READY", stdout: "READY\n" }]);
    await drivers["exe-dev"].create!(fx.device("vm"), fx.ctx);
    const calls = await fx.stubs.calls();
    assert.equal(calls.some((c) => c.args.includes("new")), false, "no VM is created when it already exists");
    assert.ok(calls.at(-1)!.args.includes("dpi-test-vm.exe.xyz"));
    assert.deepEqual(fx.logs, ["create vm: VM dpi-test-vm already exists", "create vm: ssh dpi-test-vm.exe.xyz ready"]);
  } finally {
    await fx.dispose();
  }
});

test("create makes a missing VM with the requested size, then waits for ssh", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([vmList("someone-elses-vm"), { match: "echo READY", stdout: "READY\n" }]);
    await drivers["exe-dev"].create!(fx.device("vm"), fx.ctx);
    const created = (await fx.stubs.calls()).find((c) => c.args.includes("new"))!;
    assert.deepEqual(created.args.slice(-7), ["exe.dev", "new", "--name=dpi-test-vm", "--cpu=2", "--memory=4GB", "--disk=20GB", "--json"]);
    assert.ok(fx.logs[0].startsWith("create vm: ssh exe.dev new --name=dpi-test-vm"));
  } finally {
    await fx.dispose();
  }
});

test("the VM list accepts vm_name, name or dns_name entries", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    for (const entry of [{ vm_name: "dpi-test-vm" }, { name: "dpi-test-vm" }, { dns_name: "dpi-test-vm.exe.xyz" }]) {
      await fx.stubs.reset();
      await fx.stubs.rules([{ match: "exe\\.dev ls --json", stdout: JSON.stringify({ vms: [entry] }) }, { match: "echo READY", stdout: "READY\n" }]);
      await drivers["exe-dev"].create!(fx.device("vm"), fx.ctx);
      assert.equal((await fx.stubs.calls()).some((c) => c.args.includes("new")), false, JSON.stringify(entry));
    }
  } finally {
    await fx.dispose();
  }
});

test("expose shares the port and makes it public", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await drivers["exe-dev"].expose!(fx.device("vm"), fx.ctx);
    const calls = await fx.stubs.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(-6), ["exe.dev", "share", "port", "dpi-test-vm", "4780", "--json"]);
    assert.deepEqual(calls[1].args.slice(-5), ["exe.dev", "share", "set-public", "dpi-test-vm", "--json"]);
    assert.match(fx.logs[0], /^expose vm: https:\/\/dpi-test-vm\.exe\.xyz → :4780, public/);
  } finally {
    await fx.dispose();
  }
});

test("destroy removes only a VM that exists, with --yes, and forgets its uid", async () => {
  const fx = await fixture(SSH_YAML, undefined, ["--yes"]);
  try {
    fx.ctx.registry.upsert({ id: "vm", url: "https://dpi-test-vm.exe.xyz", source: "config" });
    fx.ctx.registry.learnUid("vm", "uid-x");
    await fx.stubs.rules([vmList("another-vm")]);
    await drivers["exe-dev"].destroy!(fx.device("vm"), fx.ctx);
    assert.equal((await fx.stubs.calls()).some((c) => c.args.includes("rm")), false, "a missing VM is not removed");
    assert.equal(fx.logs.at(-1), "destroy vm: VM dpi-test-vm does not exist");
    assert.equal(fx.ctx.registry.get("vm")!.deviceUid, "uid-x");

    await fx.stubs.reset();
    await fx.stubs.rules([vmList("another-vm", "dpi-test-vm")]);
    await drivers["exe-dev"].destroy!(fx.device("vm"), fx.ctx);
    const rm = (await fx.stubs.calls()).filter((c) => c.args.includes("rm"));
    assert.equal(rm.length, 1);
    assert.deepEqual(rm[0].args.slice(-3), ["rm", "dpi-test-vm", "--json"]);
    assert.equal(fx.ctx.registry.get("vm")!.deviceUid, null);
    assert.equal(fx.logs.at(-1), "destroy vm: VM dpi-test-vm removed");
  } finally {
    await fx.dispose();
  }
});

/** Feed `answer` to the interactive confirmation that destroy reads from process.stdin. */
async function withStdin<T>(answer: string, fn: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const input = new PassThrough();
  input.end(answer);
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  try {
    return await captureStdout("Destroy exe.dev VM", fn);
  } finally {
    Object.defineProperty(process, "stdin", original);
  }
}

test("destroy without --yes asks for the VM name and cancels on anything else", async () => {
  const fx = await fixture(SSH_YAML);
  try {
    await fx.stubs.rules([vmList("dpi-test-vm")]);
    fx.ctx.registry.upsert({ id: "vm", url: "https://dpi-test-vm.exe.xyz", source: "config" });
    fx.ctx.registry.learnUid("vm", "uid-x");
    const wrong = await withStdin("some-other-vm\n", () => drivers["exe-dev"].destroy!(fx.device("vm"), fx.ctx));
    assert.match(wrong.captured, /Destroy exe\.dev VM dpi-test-vm and its disk\? Type the VM name to confirm: /);
    assert.equal(fx.logs.at(-1), "destroy: cancelled");
    assert.equal((await fx.stubs.calls()).some((c) => c.args.includes("rm")), false, "nothing is removed on a wrong answer");
    assert.equal(fx.ctx.registry.get("vm")!.deviceUid, "uid-x");

    await withStdin("  dpi-test-vm  \n", () => drivers["exe-dev"].destroy!(fx.device("vm"), fx.ctx));
    assert.equal((await fx.stubs.calls()).filter((c) => c.args.includes("rm")).length, 1);
    assert.equal(fx.logs.at(-1), "destroy vm: VM dpi-test-vm removed");
  } finally {
    await fx.dispose();
  }
});

test("up on an exe.dev device creates, provisions, deploys, configures, exposes and registers, in that order", async () => {
  const fx = await fixture(SSH_YAML);
  const fetchStub = stubFetch(() => deviceInfoResponse());
  try {
    await fx.stubs.rules([vmList("dpi-test-vm"), { match: "echo READY", stdout: "READY\n" }, FACTS, REGISTER_TOKEN, { match: "nvm install", stdout: "node: /n\n" }]);
    await drivers["exe-dev"].up!(fx.device("vm"), fx.ctx);
    const phases = fx.logs.map((l) => l.match(/^(create|provision|deploy|env|service|expose|register|online)/)?.[1]).filter(Boolean);
    assert.deepEqual([...new Set(phases)], ["create", "provision", "deploy", "env", "service", "expose", "register", "online"]);
    assert.equal(fx.ctx.registry.get("vm")!.token, TOKEN);
  } finally {
    fetchStub.restore();
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ local driver (real sh, temp HOME)

const LOCAL_YAML = `devices:
  here:
    kind: local
    port: 4999
    env_keys: [DPI_TEST_SECRET]
    env: { DPI_PROVIDER: faux }
`;

const tokenLine = (text: string) => text.split("\n")[0];

test("local env writes ~/.dpi/backend.env privately: a fresh token, the settings, the secrets, and the start dirs", async () => {
  const fx = await fixture(LOCAL_YAML, `DPI_TEST_SECRET=${SECRET}\n`);
  try {
    await drivers.local.env!(fx.device("here"), fx.ctx);
    const file = join(fx.stubs.home, ".dpi/backend.env");
    const text = await readFile(file, "utf8");
    assert.match(tokenLine(text), /^DPI_TOKEN=dpi_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(text.trimEnd().split("\n").slice(1), [
      "DPI_DEVICE_NAME=here",
      "DPI_PORT=4999",
      "DPI_HOST=127.0.0.1",
      "DPI_START_DIRS=~/dpi-work",
      `DPI_TEST_SECRET=${SECRET}`,
      "DPI_PROVIDER=faux",
    ]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(fx.stubs.home, ".dpi"))).mode & 0o777, 0o700, "umask 077 keeps the directory private");
    assert.equal((await stat(join(fx.stubs.home, "dpi-work"))).isDirectory(), true, "start dirs are created");
    assert.equal((await stat(file + ".tmp").catch(() => null)), null, "no temp file is left behind");
    assert.equal(fx.logs.at(-1), "env here: ~/.dpi/backend.env written (token kept or created)");
  } finally {
    await fx.dispose();
  }
});

test("local env keeps the existing token, and rotate replaces it and registers the new one", async () => {
  const fx = await fixture(LOCAL_YAML, `DPI_TEST_SECRET=${SECRET}\n`);
  try {
    const file = join(fx.stubs.home, ".dpi/backend.env");
    await drivers.local.env!(fx.device("here"), fx.ctx);
    const first = tokenLine(await readFile(file, "utf8"));
    await drivers.local.env!(fx.device("here"), fx.ctx);
    assert.equal(tokenLine(await readFile(file, "utf8")), first, "a second run keeps the token");

    await drivers.local.rotate!(fx.device("here"), fx.ctx);
    const rotated = tokenLine(await readFile(file, "utf8"));
    assert.notEqual(rotated, first);
    assert.equal(fx.ctx.registry.get("here")!.token, rotated.replace("DPI_TOKEN=", ""));
    assert.equal(fx.logs.at(-1), "restart the local backend to use the new token");
    assert.ok(fx.logs.some((l) => l.includes("token rotated")));
  } finally {
    await fx.dispose();
  }
});

test("local register reads the token from the env file; a missing file is explained", async () => {
  const fx = await fixture(LOCAL_YAML);
  try {
    await assert.rejects(drivers.local.register!(fx.device("here"), fx.ctx), /here: no DPI_TOKEN in ~\/\.dpi\/backend\.env; run: just net step env here/);
    await mkdir(join(fx.stubs.home, ".dpi"), { recursive: true });
    await writeFile(join(fx.stubs.home, ".dpi/backend.env"), `DPI_PORT=1\nDPI_TOKEN=${TOKEN}\nDPI_TOKEN=${"z".repeat(40)}\n`);
    await drivers.local.register!(fx.device("here"), fx.ctx);
    assert.equal(fx.ctx.registry.get("here")!.token, TOKEN, "the first DPI_TOKEN line wins");
    assert.equal(fx.ctx.registry.get("here")!.source, "config");
    assert.equal(fx.ctx.registry.get("here")!.url, "http://127.0.0.1:4999");
  } finally {
    await fx.dispose();
  }
});

test("local up without a service writes the env, registers, and says how to start the backend", async () => {
  const fx = await fixture(LOCAL_YAML);
  try {
    await drivers.local.up!(fx.device("here"), fx.ctx);
    assert.ok(fx.ctx.registry.get("here")!.token);
    assert.equal(fx.logs.at(-1), "up here: env ready. Start it with: just backend run   (it reads ~/.dpi/backend.env)");
    assert.deepEqual(await fx.stubs.calls(), [], "a local device never touches ssh");
  } finally {
    await fx.dispose();
  }
});

test("local restart, down and service need a service setting and run nothing otherwise", async () => {
  const fx = await fixture(LOCAL_YAML);
  try {
    await assert.rejects(drivers.local.restart!(fx.device("here"), fx.ctx), /here has no service; it runs with `just backend run`/);
    await assert.rejects(drivers.local.down!(fx.device("here"), fx.ctx), /here has no service/);
    await assert.rejects(drivers.local.service!(fx.device("here"), fx.ctx), /here has no service in dpi-network\.yaml/);
  } finally {
    await fx.dispose();
  }
});

test("local logs tail the real log file, or say there is none yet", async () => {
  const fx = await fixture(LOCAL_YAML);
  try {
    const none = await captureStdout("no log yet", () => drivers.local.logs!(fx.device("here"), fx.ctx));
    assert.equal(none.captured, "(no log yet at ~/.dpi/backend.log)\n");
    await mkdir(join(fx.stubs.home, ".dpi"), { recursive: true });
    await writeFile(join(fx.stubs.home, ".dpi/backend.log"), Array.from({ length: 10 }, (_, i) => `LOGROW-${i}`).join("\n") + "\n");
    fx.ctx.args = ["3"];
    const last = await captureStdout("LOGROW", () => drivers.local.logs!(fx.device("here"), fx.ctx));
    assert.equal(last.captured, "LOGROW-7\nLOGROW-8\nLOGROW-9\n");
  } finally {
    await fx.dispose();
  }
});

// ------------------------------------------------------------------ the templates the service step fills

test("the shipped service templates only use placeholders that installService provides", async () => {
  const provided = new Set(["LABEL", "UNIT", "NODE", "APP", "HOME", "USER", "DPI_HOME", "LOG", "PATH"]);
  for (const file of ["dpi-backend.plist", "dpi-backend.service"]) {
    const text = await readFile(new URL(file, templates), "utf8");
    const used = [...text.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]);
    assert.ok(used.length > 0, file);
    for (const key of used) assert.ok(provided.has(key), `${file} uses __${key}__`);
  }
  assert.equal(shPath("~/x"), "$HOME/x");
});
