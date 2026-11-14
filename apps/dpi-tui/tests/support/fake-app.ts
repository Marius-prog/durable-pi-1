// A stand-in for `App` as commands.ts and pickers.ts see it: records what they ask of it and hands them a
// client and agent handle whose calls are recorded. The code under test is the commands and pickers, not App.
import type { Component } from "@earendil-works/pi-tui";
import type { AgentSummary, DeviceInfo, SessionSummary, TaskNode } from "../../../dpi-sdk/src/api.ts";
import type { WireEntry } from "../../../dpi-sdk/src/api.ts";
import type { App } from "../../src/app.ts";
import { agent, deviceInfo, session } from "./fake-device.ts";

export type Call = [method: string, ...args: unknown[]];

export class FakeApp {
  readonly calls: Call[] = [];
  readonly flashes: { text: string; error: boolean }[] = [];
  readonly overlays: Component[] = [];
  readonly closed: boolean[] = [];
  readonly attached: [string, number][] = [];
  readonly switched: string[] = [];
  readonly prompts: { label: string; initial: string }[] = [];
  /** Answers handed to `prompt()` in order; `undefined` cancels. */
  promptAnswers: (string | undefined)[] = [];
  exited = 0;
  device = { id: "dev", name: "Dev", url: "http://dev.test:4780", token: "unused" };
  info: DeviceInfo = deviceInfo();
  registry?: { list(): unknown[] };
  sessionId?: string = "s1";
  agentId?: number = 1;
  summary?: SessionSummary = session("s1", "triage");
  tasks: TaskNode[] = [];
  entries: Pick<WireEntry, "id" | "kind">[] = [];
  agentModel?: { provider: string; modelId: string };
  /** Make the next calls to these handle methods reject. */
  failing = new Map<string, Error>();
  dirs: Record<string, unknown> = {};
  trees: SessionSummary[] = [];

  /** Same shape App's commands use: `app.handle.fork(...)`. */
  handle?: Record<string, (...args: any[]) => Promise<unknown>>;
  client: any;

  constructor() {
    const record = (method: string, result: unknown) => async (...args: unknown[]) => {
      this.calls.push([method, ...args]);
      const failure = this.failing.get(method);
      if (failure) throw failure;
      return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
    };
    this.handle = {
      fork: record("fork", (body: { name?: string }) => ({ ...agent(7), name: body.name ?? "Fork 7", kind: "fork" })),
      configure: record("configure", {}),
      compact: record("compact", { taskId: 1 }),
      reset: record("reset", { ok: true }),
      rename: record("rename", {}),
    };
    this.client = {
      session: (ref: string) => ({
        createAgent: record("createAgent", (body: { name?: string }): AgentSummary => ({ ...agent(5), name: body.name ?? "Agent 5" })),
        ref,
      }),
      tree: record("tree", () => ({ uid: "u", name: "dev", sessions: this.trees, at: 0 })),
      dirs: record("dirs", (path: string) => {
        const listing = this.dirs[path];
        if (!listing) throw new Error(`No such directory: ${path}`);
        return listing;
      }),
      createSession: record("createSession", (body: { name: string; cwd: string }) => ({ ...session("new-id", body.name), cwd: body.cwd })),
    };
  }

  get model() {
    return { state: { entries: this.entries, agent: { model: this.agentModel } } };
  }
  get session() {
    return { state: { tasks: this.tasks, agents: this.summary?.agents ?? [] } };
  }

  sessionSummary() {
    return this.summary;
  }
  async attach(sessionId: string, agentId: number) {
    this.attached.push([sessionId, agentId]);
  }
  async switchDevice(id: string) {
    this.switched.push(id);
  }
  flash(text: string, error = false) {
    this.flashes.push({ text, error });
  }
  async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.flash((e as Error).message, true);
    }
  }
  overlay(component: Component) {
    this.overlays.push(component);
  }
  closeOverlay(exitIfNothing = false) {
    this.closed.push(exitIfNothing);
    this.overlays.pop();
    if (exitIfNothing) this.exit();
  }
  prompt(label: string, initial: string) {
    this.prompts.push({ label, initial });
    return Promise.resolve(this.promptAnswers.shift());
  }
  exit() {
    this.exited++;
  }

  get top() {
    return this.overlays.at(-1);
  }
  get asApp() {
    return this as unknown as App;
  }
  /** Calls to one method, without the method name. */
  args(method: string) {
    return this.calls.filter((c) => c[0] === method).map((c) => c.slice(1));
  }
}
