import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** PID of the live process holding this lock, if any. */
export function lockOwner(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  // An empty or garbled file (a crash mid-write) is stale. Never signal pid 0: it means the whole process group.
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  if (pid < 1 || pid > 2 ** 31 - 1) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else. Anything else (ESRCH): it is gone.
    return (e as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/** One process owns a SQLite file at a time. Returns the release function. */
export function lockFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const owner = lockOwner(path);
  if (owner !== undefined && owner !== process.pid)
    throw Error(`Already owned by process ${owner}: ${path}`);
  writeFileSync(path, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}
