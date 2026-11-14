// Runs `src/main.ts` as a real child process (pipes instead of a terminal) with a scratch DPI_HOME and a scrubbed
// environment, so nothing of the developer's own registry, config file or tokens can leak in.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NetworkRegistry } from "../../../dpi-sdk/src/node/registry.ts";
import { strip } from "./fake-terminal.ts";

const MAIN = resolve(import.meta.dirname, "../../src/main.ts");
const TSX = import.meta.resolve("tsx");

export interface Scratch {
  dir: string;
  /** The registry the child sees (DPI_HOME/network.sqlite). */
  registry: NetworkRegistry;
  cleanup(): void;
}

export function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "dpi-tui-main-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  return {
    dir,
    registry,
    cleanup: () => {
      registry.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Running {
  /** Send keys to the child's stdin; its terminal reads them as typed input. */
  send(data: string): void;
  done: Promise<Result>;
  kill(): void;
}

export function runMain(dir: string, args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      DPI_HOME: dir,
      INIT_CWD: dir,
      // keep the test runner's coverage collection working for the child
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const done = new Promise<Result>((resolveDone) =>
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveDone({ code, signal, stdout: strip(stdout), stderr: strip(stderr) });
    }),
  );
  return { send: (data) => void child.stdin.write(data), done, kill: () => void child.kill("SIGKILL") };
}

/** Run to completion (for invocations that fail before drawing anything). */
export const runToExit = (dir: string, args: string[], env: Record<string, string> = {}) => runMain(dir, args, env).done;
