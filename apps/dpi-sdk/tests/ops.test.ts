import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_OPTS, exeDev, q, remote, rsync, run, shPath, sleep, sshTarget } from "../src/node/ops.js";
import type { NetDevice } from "../src/node/config.js";
import { installStubs } from "./helpers/stub-bin.js";

const node = process.execPath;
const device = (over: Partial<NetDevice> = {}): NetDevice => ({
  id: "box",
  name: "Box",
  kind: "ssh",
  url: "http://box.invalid:4780",
  port: 4780,
  node: 24,
  codeDir: "~/dpi",
  homeDir: "~/.dpi",
  host: "0.0.0.0",
  startDirs: ["~/dpi-work"],
  envKeys: [],
  env: {},
  ssh: "dpi@box.invalid",
  service: "systemd",
  ...over,
});

/** Capture what a block writes to process.stdout that contains `marker`; everything else passes through. */
async function captureStdout<T>(marker: string, fn: () => Promise<T>) {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  const patched = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (text.includes(marker)) {
      captured.push(text);
      return true;
    }
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stdout.write = patched;
  try {
    return { result: await fn(), captured: captured.join("") };
  } finally {
    process.stdout.write = original;
  }
}

// ------------------------------------------------------------------ run (real local child processes)

test("run captures stdout, stderr and the exit code of a child", async () => {
  const out = await run(node, ["-e", 'process.stdout.write("out"); process.stderr.write("err")']);
  assert.deepEqual(out, { code: 0, stdout: "out", stderr: "err" });
});

test("run sends stdin to the child and closes it (an empty stdin by default)", async () => {
  const echo = 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write("["+s+"]"))';
  assert.equal((await run(node, ["-e", echo], { stdin: "hello\nworld" })).stdout, "[hello\nworld]");
  assert.equal((await run(node, ["-e", echo])).stdout, "[]");
});

test("run passes cwd and env to the child", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dpi-ops-")));
  try {
    const out = await run(node, ["-e", 'process.stdout.write(process.cwd() + "|" + process.env.DPI_OPS_TEST + "|" + (process.env.HOME ?? "unset"))'], {
      cwd: dir,
      env: { DPI_OPS_TEST: "yes", PATH: process.env.PATH },
    });
    assert.equal(out.stdout, `${dir}|yes|unset`, "an explicit env replaces the inherited one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-zero exit rejects with the command, exit code and the tail of stderr, and attaches the result", async () => {
  const script = 'process.stderr.write("x".repeat(2000) + "END"); process.stdout.write("partial"); process.exit(3)';
  await assert.rejects(run(node, ["-e", script]), (e: unknown) => {
    const error = e as Error & { result: { code: number; stdout: string; stderr: string } };
    assert.match(error.message, / -e .* … failed \(exit 3\): /);
    assert.ok(error.message.endsWith("END"));
    assert.ok(error.message.length < 1200, "stderr is cut to its last 800 characters");
    assert.deepEqual([error.result.code, error.result.stdout], [3, "partial"]);
    assert.equal(error.result.stderr.length, 2003);
    return true;
  });
});

test("allowFail turns a failing exit into a normal result", async () => {
  const out = await run(node, ["-e", "process.exit(7)"], { allowFail: true });
  assert.deepEqual(out, { code: 7, stdout: "", stderr: "" });
});

test("a missing command rejects with the spawn error", async () => {
  await assert.rejects(run("definitely-not-a-real-command-dpi", []), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
});

test("timeoutMs kills a hung child with SIGTERM and says so in stderr", async () => {
  const started = Date.now();
  const out = await run(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 150, allowFail: true });
  assert.ok(Date.now() - started < 5000);
  assert.equal(out.code, 1, "a signalled child has no exit code, which run reports as 1");
  assert.match(out.stderr, /\[timeout after 150ms\]/);
  await assert.rejects(run(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), /timeout after 100ms/);
});

test("a fast child is not disturbed by a generous timeout", async () => {
  assert.equal((await run(node, ["-e", 'process.stdout.write("ok")'], { timeoutMs: 10_000 })).stdout, "ok");
});

test("echo mirrors child output to this process while still capturing it", async () => {
  const marker = "dpi-ops-echo-marker";
  const { result, captured } = await captureStdout(marker, () => run(node, ["-e", `process.stdout.write("${marker}")`], { echo: true }));
  assert.equal(result.stdout, marker);
  assert.equal(captured, marker);
  const quiet = await captureStdout(marker, () => run(node, ["-e", `process.stdout.write("${marker}")`]));
  assert.equal(quiet.captured, "", "without echo nothing is mirrored");
});

// ------------------------------------------------------------------ small helpers

test("shPath turns a leading ~ into $HOME and leaves other paths alone", () => {
  assert.equal(shPath("~"), "$HOME");
  assert.equal(shPath("~/dpi/apps"), "$HOME/dpi/apps");
  assert.equal(shPath("/abs/path"), "/abs/path");
  assert.equal(shPath("rel/path"), "rel/path");
  assert.equal(shPath("~other/x"), "~other/x");
  assert.equal(shPath("a/~/b"), "a/~/b");
});

test("q single-quotes any value so a POSIX shell reads it back unchanged", () => {
  assert.equal(q("plain"), "'plain'");
  assert.equal(q("it's"), `'it'\\''s'`);
  const nasty = [`a b`, `$(echo injected)`, "`id`", `"double"`, `'; echo injected ;'`, "line\nbreak", "back\\slash", "", "*?[x]", "~", "'''"];
  for (const value of nasty) {
    const out = spawnSync("sh", ["-c", `printf %s ${q(value)}`], { encoding: "utf8" });
    assert.equal(out.stdout, value, JSON.stringify(value));
  }
});

test("sshTarget returns the ssh address or names the device that has none", () => {
  assert.equal(sshTarget(device()), "dpi@box.invalid");
  assert.throws(() => sshTarget(device({ ssh: undefined, kind: "url", id: "web" })), /web \(kind url\) has no ssh target/);
});

test("SSH_OPTS never prompt and never hang", () => {
  const joined = SSH_OPTS.join(" ");
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /ConnectTimeout=15/);
  assert.match(joined, /StrictHostKeyChecking=accept-new/);
  assert.match(joined, /ServerAliveInterval=15/);
  assert.equal(SSH_OPTS.filter((o) => o === "-o").length, SSH_OPTS.length / 2, "every option is introduced by -o");
});

test("sleep waits at least the requested time", async () => {
  const started = Date.now();
  await sleep(40);
  assert.ok(Date.now() - started >= 35);
});

// ------------------------------------------------------------------ ssh, rsync and exe.dev through stubs

test("the stubbed ssh and rsync really are first on PATH (guard for every test that relies on them)", async () => {
  const stubs = await installStubs();
  try {
    const found = spawnSync("sh", ["-c", "command -v ssh; command -v rsync"], { encoding: "utf8" }).stdout.trim().split("\n");
    assert.deepEqual(found, [join(stubs.dir, "bin/ssh"), join(stubs.dir, "bin/rsync")]);
  } finally {
    await stubs.dispose();
  }
});

test("disposing the stubs restores the environment and removes the temp dir", async () => {
  const before = { PATH: process.env.PATH, HOME: process.env.HOME };
  const stubs = await installStubs();
  assert.notEqual(process.env.PATH, before.PATH);
  await stubs.dispose();
  assert.deepEqual({ PATH: process.env.PATH, HOME: process.env.HOME }, before);
  assert.equal(existsSync(stubs.dir), false);
});

test("remote() sends the script, prelude included, over stdin and only `sh -s` over argv", async () => {
  const stubs = await installStubs();
  try {
    await stubs.rules([{ match: "echo remote-ok", stdout: "remote-ok\n" }]);
    const secret = "TOPSECRET-VALUE-123";
    const out = await remote(device(), `echo remote-ok\necho ${secret} >/dev/null`);
    assert.equal(out.stdout, "remote-ok\n");
    const [call] = await stubs.calls();
    assert.equal(call.cmd, "ssh");
    assert.deepEqual(call.args, [...SSH_OPTS, "dpi@box.invalid", "sh -s"]);
    assert.ok(call.stdin.startsWith("set -e\nexport NVM_DIR="), "the prelude comes first");
    assert.match(call.stdin, /NVM_DIR="\$HOME\/\.nvm"[\s\S]*nvm\.sh/);
    assert.ok(call.stdin.endsWith(`echo ${secret} >/dev/null`));
    assert.equal(call.args.join(" ").includes(secret), false, "nothing from the script is visible in argv");
  } finally {
    await stubs.dispose();
  }
});

test("remote() on a device without an ssh target fails before spawning anything", async () => {
  const stubs = await installStubs();
  try {
    assert.throws(() => remote(device({ ssh: undefined }), "true"), /has no ssh target/);
    assert.deepEqual(await stubs.calls(), []);
  } finally {
    await stubs.dispose();
  }
});

test("remote() surfaces a failing script as a rejection and passes allowFail through", async () => {
  const stubs = await installStubs();
  try {
    await stubs.rules([{ match: "will-fail", code: 255, stderr: "ssh: connect to host box.invalid port 22: Connection refused\n" }]);
    await assert.rejects(remote(device(), "will-fail"), /ssh .* failed \(exit 255\): ssh: connect to host box\.invalid/);
    const soft = await remote(device(), "will-fail", { allowFail: true });
    assert.equal(soft.code, 255);
  } finally {
    await stubs.dispose();
  }
});

test("rsync() syncs with --delete, the standard excludes and ssh options to <ssh>:<dest>", async () => {
  const stubs = await installStubs();
  try {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "dpi-rsync-")));
    try {
      await rsync(device(), ["apps/dpi-backend", "apps/dpi-sdk"], "dpi/apps/", cwd);
      const [call] = await stubs.calls();
      assert.equal(call.cmd, "rsync");
      const args = call.args;
      assert.deepEqual(args.slice(0, 2), ["-a", "--delete"]);
      const excludes = args.flatMap((a, i) => (args[i - 1] === "--exclude" ? [a] : []));
      assert.deepEqual(excludes, ["node_modules", ".data", ".durable-pi", "dist", "*.log", ".DS_Store"]);
      assert.equal(args[args.indexOf("-e") + 1], `ssh ${SSH_OPTS.join(" ")}`);
      assert.deepEqual(args.slice(-3), ["apps/dpi-backend", "apps/dpi-sdk", "dpi@box.invalid:dpi/apps/"]);
      assert.throws(() => rsync(device({ ssh: undefined }), ["a"], "d", cwd), /no ssh target/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } finally {
    await stubs.dispose();
  }
});

test("exeDev() talks to exe.dev with --json and parses the answer; odd output is kept raw", async () => {
  const stubs = await installStubs();
  try {
    await stubs.rules([
      { match: "exe.dev ls --json", stdout: '{"vms":[{"vm_name":"a"}]}\n' },
      { match: "exe.dev empty --json", stdout: "  \n" },
      { match: "exe.dev garbage --json", stdout: "Not JSON at all\n" },
    ]);
    assert.deepEqual(await exeDev(["ls"]), { vms: [{ vm_name: "a" }] });
    assert.deepEqual(await exeDev(["empty"]), {});
    assert.deepEqual(await exeDev(["garbage"]), { raw: "Not JSON at all" });
    const calls = await stubs.calls();
    assert.deepEqual(calls[0].args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "exe.dev", "ls", "--json"]);
    assert.equal(calls[0].stdin, "");
  } finally {
    await stubs.dispose();
  }
});

test("exeDev() rejects when the control plane call fails", async () => {
  const stubs = await installStubs();
  try {
    await stubs.rules([{ match: "exe.dev rm", code: 1, stderr: "no such vm" }]);
    await assert.rejects(exeDev(["rm", "ghost"]), /failed \(exit 1\): no such vm/);
  } finally {
    await stubs.dispose();
  }
});
