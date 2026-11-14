// Starts the real App against a fake device and a fake terminal, with process.exit and stdout captured.
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DpiClient } from "../../../dpi-sdk/src/client.ts";
import { NetworkRegistry } from "../../../dpi-sdk/src/node/registry.ts";
import type { Frame, WireSnapshotEvent } from "../../../dpi-sdk/src/api.ts";
import { App, type DeviceRef } from "../../src/app.ts";
import { FakeDevice, startFakeDevice, until } from "./fake-device.ts";
import { installFakeTerminal, strip, type FakeTerminal } from "./fake-terminal.ts";

export interface Launched {
  app: App;
  device: FakeDevice;
  term: FakeTerminal;
  registry: NetworkRegistry;
  exits: number[];
  /** Everything written to stdout while the app ran (the reattach hint). */
  stdout: string[];
  dir: string;
  /** Plain text of what App draws where; private fields read through brackets. */
  header(): string;
  footer(): string;
  status(): string[];
  /** Send one raw key sequence (stdout is captured for the duration of the call). */
  type(data: string): void;
  typeText(text: string): void;
  /** Same as the app's own exit (stdout captured). */
  exit(): void;
  close(): Promise<void>;
}

export interface LaunchOptions {
  snapshot?: Partial<WireSnapshotEvent>;
  deviceRef?: Partial<DeviceRef>;
  /** Open this session (and agent) right away and wait for the live stream. */
  open?: [session: string, agent?: string];
}

// App.flash schedules a redraw 6.1 s ahead and never unrefs it; without this the finished test process would idle
// for that long after the last flash.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  const timer = realSetTimeout(handler as () => void, delay, ...args);
  if (delay === 6100) (timer as unknown as NodeJS.Timeout).unref?.();
  return timer;
}) as typeof setTimeout;

/**
 * Collect what `fn` writes to stdout. Only for synchronous code: the test runner reports results through stdout too,
 * so the real write must be back in place before anything yields to the event loop.
 */
export function captureStdout<T>(sink: string[], fn: () => T): T {
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => (sink.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    return fn();
  } finally {
    process.stdout.write = original;
  }
}

export async function launch(options: LaunchOptions = {}): Promise<Launched> {
  const device = await startFakeDevice();
  if (options.snapshot) device.agentSnapshot = { ...device.agentSnapshot, ...options.snapshot };
  const term = installFakeTerminal();
  const exits: number[] = [];
  const stdout: string[] = [];
  const exitMock = mock.method(process, "exit", ((code?: number) => void exits.push(code ?? 0)) as never);
  const dir = mkdtempSync(join(tmpdir(), "dpi-tui-test-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const ref: DeviceRef = { id: "fake", name: "Fake", url: device.url, token: "unused-by-the-fake", ...options.deviceRef };
  const app = new App(ref, new DpiClient(ref.url, ref.token), device.info, registry);
  const priv = app as unknown as Record<string, any>;
  let closed = false;
  const launched: Launched = {
    app,
    device,
    term,
    registry,
    exits,
    stdout,
    dir,
    header: () => strip(priv.header.text).trim(),
    footer: () => strip(priv.footer.text).trim(),
    status: () => priv.statusLines().map(strip),
    type: (data) => captureStdout(stdout, () => term.type(data)),
    typeText: (text) => {
      for (const ch of text) launched.type(ch);
    },
    exit: () => captureStdout(stdout, () => app.exit()),
    close: async () => {
      if (closed) return;
      closed = true;
      launched.exit();
      exitMock.mock.restore();
      term.restore();
      registry.db.close();
      rmSync(dir, { recursive: true, force: true });
      await device.close();
    },
  };
  if (options.open) {
    await app.open(...options.open);
    await until(() => launched.header().includes("● live"), "the agent stream to go live");
  }
  return launched;
}

/** Run a test body with a launched app and always clean up. */
export async function withApp(options: LaunchOptions, body: (ctx: Launched) => Promise<void>) {
  const ctx = await launch(options);
  try {
    await body(ctx);
  } finally {
    await ctx.close();
  }
}

export const batch = (...events: Extract<Frame, { type: "batch" }>["events"][number][]): Frame => ({ type: "batch", events });
