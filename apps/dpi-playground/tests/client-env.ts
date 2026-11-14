// Runs the Vue client's TypeScript modules (apps/dpi-playground-fe/src/client) under Node, with
// stand-ins for the few browser globals they touch: window.matchMedia, EventSource, document and
// fetch. The modules are loaded through tsx with the client's own tsconfig, so `@sdk/*` resolves
// as it does under Vite, and all of them share one module graph (one store, one HubStream).
import { resolve } from "node:path";
import { register } from "tsx/esm/api";
import type { Frame, MuxFrame } from "../../dpi-sdk/src/api.js";

export interface FetchCall {
  method: string;
  /** Path and query, as the client wrote them. */
  url: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or undefined when there was none. */
  body: unknown;
}

export type FetchReply = { status?: number; body?: unknown; statusText?: string; raw?: string };

/** `fetch` for the client: records every call and answers from `handler` (default: 200 `{}`). */
export class FakeFetch {
  calls: FetchCall[] = [];
  handler: (call: FetchCall) => FetchReply | Promise<FetchReply> = () => ({});

  fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown;
    if (typeof init.body === "string" && init.body) body = JSON.parse(init.body);
    const call: FetchCall = { method: init.method ?? "GET", url: String(input), headers, body };
    this.calls.push(call);
    const reply = await this.handler(call);
    const status = reply.status ?? 200;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
      status,
      statusText: reply.statusText ?? (status === 200 ? "OK" : "Error"),
      headers: { "content-type": "application/json" },
    });
  };

  reset() {
    this.calls = [];
    this.handler = () => ({});
  }

  to(method: string, url: string | RegExp) {
    return this.calls.filter(
      (c) => c.method === method && (typeof url === "string" ? c.url === url : url.test(c.url)),
    );
  }
}

/** The part of EventSource that HubStream uses. */
export class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static get latest() {
    return FakeEventSource.instances.at(-1)!;
  }
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  /** Deliver one mux frame, as the hub would. */
  send(sub: string, frame: MuxFrame["frame"]) {
    this.onmessage?.({ data: JSON.stringify({ sub, frame } satisfies MuxFrame) });
  }
  /** The hub's first frame. */
  hello(streamId: string) {
    this.readyState = FakeEventSource.OPEN;
    this.send("hello", { type: "stream", streamId });
  }
  /** The connection broke: EventSource goes back to CONNECTING by itself, or to CLOSED when it gives up. */
  fail(state: number = FakeEventSource.CONNECTING) {
    this.readyState = state;
    this.onerror?.();
  }
}

export class FakeMediaQuery {
  matches = false;
  private listeners = new Set<(e: { matches: boolean }) => void>();
  addEventListener(_type: "change", fn: (e: { matches: boolean }) => void) {
    this.listeners.add(fn);
  }
  /** The window crossed the breakpoint. */
  change(matches: boolean) {
    this.matches = matches;
    for (const fn of this.listeners) fn({ matches });
  }
}

export class FakeDocument {
  /** What querySelector was asked for, and the element it found (if any). */
  queries: string[] = [];
  found = new Map<string, { scrolled: unknown[]; focused: number }>();
  querySelector(selector: string) {
    this.queries.push(selector);
    const hit = this.found.get(selector);
    if (!hit) return null;
    return {
      scrollIntoView: (options: unknown) => void hit.scrolled.push(options),
      focus: () => void hit.focused++,
    };
  }
  /** Make `selector` find an element. */
  add(selector: string) {
    const hit = { scrolled: [] as unknown[], focused: 0 };
    this.found.set(selector, hit);
    return hit;
  }
}

export interface Browser {
  fetch: FakeFetch;
  media: FakeMediaQuery;
  document: FakeDocument;
  /**
   * Install `document`. Do it after loadClient(): Vue's DOM runtime looks for a real document when
   * it loads, and the client only touches `document` inside functions.
   */
  attachDocument(): void;
  /** Put the original globals back. */
  restore(): void;
}

/** Install the stand-ins. Call before importing any client module. */
export function installBrowser(options: { userAgent?: string; narrow?: boolean } = {}): Browser {
  const g = globalThis as Record<string, unknown>;
  const names = [
    "window",
    "EventSource",
    "document",
    "fetch",
    "setInterval",
    "setTimeout",
    "navigator",
  ] as const;
  const originals = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const media = new FakeMediaQuery();
  media.matches = options.narrow ?? false;
  const fetch = new FakeFetch();
  const document = new FakeDocument();
  g.window = { matchMedia: () => media };
  g.EventSource = FakeEventSource;
  g.fetch = fetch.fn;
  // jobs.ts starts a one-second clock when it loads and notify() keeps a 4.5s toast timer: neither
  // may keep the test process alive.
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  g.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const timer = realInterval(fn, ms, ...rest);
    timer.unref();
    return timer;
  }) as typeof setInterval;
  g.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const timer = realTimeout(fn, ms, ...rest);
    if ((ms ?? 0) >= 4000) timer.unref();
    return timer;
  }) as typeof setTimeout;
  if (options.userAgent !== undefined)
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: options.userAgent },
      configurable: true,
      writable: true,
    });
  return {
    fetch,
    media,
    document,
    attachDocument() {
      g.document = document;
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete g[name];
      }
    },
  };
}

type Mod<T> = T;
export interface ClientModules {
  store: typeof import("../apps/dpi-playground-fe/src/client/store.js");
  commands: typeof import("../apps/dpi-playground-fe/src/client/commands.js");
  jobs: typeof import("../apps/dpi-playground-fe/src/client/jobs.js");
  stream: typeof import("../apps/dpi-playground-fe/src/client/stream.js");
  hub: typeof import("../apps/dpi-playground-fe/src/client/hub.js");
  composables: typeof import("../apps/dpi-playground-fe/src/client/composables.js");
  vue: typeof import("vue");
}

let counter = 0;

/** Load the client modules in a fresh module graph (so a test can have its own store). */
export async function loadClient(): Promise<ClientModules & { unload(): Promise<void> }> {
  const api = register({
    namespace: `fe-${++counter}`,
    tsconfig: resolve(import.meta.dirname, "../apps/dpi-playground-fe/tsconfig.json"),
  });
  const load = <T>(file: string): Promise<Mod<T>> => api.import(file, import.meta.url);
  const dir = "../apps/dpi-playground-fe/src/client/";
  const [store, commands, jobs, stream, hub, composables, vue] = await Promise.all([
    load<ClientModules["store"]>(`${dir}store.ts`),
    load<ClientModules["commands"]>(`${dir}commands.ts`),
    load<ClientModules["jobs"]>(`${dir}jobs.ts`),
    load<ClientModules["stream"]>(`${dir}stream.ts`),
    load<ClientModules["hub"]>(`${dir}hub.ts`),
    load<ClientModules["composables"]>(`${dir}composables.ts`),
    load<ClientModules["vue"]>("vue"),
  ]);
  return { store, commands, jobs, stream, hub, composables, vue, unload: () => api.unregister() };
}

export type { Frame };
