// Stand-ins for `ssh` and `rsync`, so the ops code can be exercised without touching any machine.
// The stubs are tiny node scripts placed first on PATH. Each call is appended to a log (argv + stdin) and
// answered from a rules list: the first rule whose regex matches "<argv joined by space>\n<stdin>" supplies
// stdout, stderr and the exit code. A call that matches no rule exits 0 with no output.
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface StubCall {
  cmd: string;
  args: string[];
  stdin: string;
}

export interface StubRule {
  match: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

const SCRIPT = (execPath: string) => `#!${execPath}
const fs = require("fs");
const path = require("path");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.DPI_STUB_LOG, JSON.stringify({ cmd: path.basename(process.argv[1]), args, stdin }) + "\\n");
  let rules = [];
  try { rules = JSON.parse(fs.readFileSync(process.env.DPI_STUB_RULES, "utf8")); } catch {}
  const haystack = args.join(" ") + "\\n" + stdin;
  for (const rule of rules) {
    if (new RegExp(rule.match).test(haystack)) {
      if (rule.stdout) process.stdout.write(rule.stdout);
      if (rule.stderr) process.stderr.write(rule.stderr);
      process.exit(rule.code ?? 0);
    }
  }
  process.exit(0);
});
`;

export interface Stubs {
  /** Temp dir holding the stub binaries (`bin/`), the call log and a HOME for the test. */
  dir: string;
  /** The HOME the stubbed environment points at. */
  home: string;
  /** Replace the answer rules. */
  rules(rules: StubRule[]): Promise<void>;
  /** Every call so far, in order. */
  calls(): Promise<StubCall[]>;
  /** Forget the calls made so far. */
  reset(): Promise<void>;
  /** Restore PATH and environment, delete the temp dir. */
  dispose(): Promise<void>;
}

/** Put stub `ssh` and `rsync` first on PATH and point HOME at a temp dir. */
export async function installStubs(): Promise<Stubs> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dpi-stubs-")));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const log = join(dir, "calls.jsonl");
  const rulesFile = join(dir, "rules.json");
  await mkdir(bin);
  await mkdir(home);
  for (const name of ["ssh", "rsync"]) {
    const file = join(bin, name);
    await writeFile(file, SCRIPT(process.execPath));
    chmodSync(file, 0o755);
  }
  await writeFile(log, "");
  await writeFile(rulesFile, "[]");
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DPI_STUB_LOG: process.env.DPI_STUB_LOG,
    DPI_STUB_RULES: process.env.DPI_STUB_RULES,
  };
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
  process.env.HOME = home;
  process.env.DPI_STUB_LOG = log;
  process.env.DPI_STUB_RULES = rulesFile;
  const resolved = spawnSync("sh", ["-c", "command -v ssh; command -v rsync"], { encoding: "utf8" }).stdout.trim().split("\n");
  if (resolved[0] !== join(bin, "ssh") || resolved[1] !== join(bin, "rsync")) {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    throw new Error(`refusing to continue: ssh/rsync do not resolve to the stubs (${resolved.join(", ")})`);
  }
  return {
    dir,
    home,
    rules: (rules) => writeFile(rulesFile, JSON.stringify(rules)),
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StubCall),
    reset: () => writeFile(log, ""),
    dispose: async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
