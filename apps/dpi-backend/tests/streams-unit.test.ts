// streams.ts helpers that need no server: SSE framing, coalescing, doc parsing, activity diffs.
import { test, describe, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { DeviceTree, Frame, SessionSummary } from "../../dpi-sdk/src/api.js";
import { coalesce, diffActivity, openSse, parseDocs } from "../src/streams.js";
import { delay } from "./helpers.js";

class FakeResponse extends EventEmitter {
  writableLength = 0;
  statusCode?: number;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  flushed = false;
  ended = false;
  noDelay?: boolean;
  socket = { setNoDelay: (v: boolean) => void (this.noDelay = v) };
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  set(headers: Record<string, string>) {
    Object.assign(this.headers, headers);
    return this;
  }
  flushHeaders() {
    this.flushed = true;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
  get asResponse() {
    return this as unknown as Response;
  }
}

/** Opens a stream and closes it when the test ends, so no heartbeat timer outlives the test. */
const open = (t: TestContext, scope: Parameters<typeof openSse>[1]) => {
  const res = new FakeResponse();
  const sse = openSse(res.asResponse, scope);
  t.after(() => void res.emit("close"));
  return { res, sse };
};

const frames = (res: FakeResponse) =>
  res.chunks.filter((c) => c.startsWith("id:")).map((c) => {
    const [id, event, data] = c.trimEnd().split("\n");
    return { id: Number(id.slice(4)), event: event.slice(7), frame: JSON.parse(data.slice(6)) as Frame };
  });

describe("openSse", () => {
  test("sends event-stream headers, flushes them, disables Nagle and opens with a hello frame", (t) => {
    const before = Date.now();
    const { res } = open(t, { kind: "session", sessionId: "s1" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-cache, no-transform");
    assert.equal(res.headers["x-accel-buffering"], "no");
    assert.equal(res.flushed, true);
    assert.equal(res.noDelay, true);
    const [hello] = frames(res);
    assert.equal(hello.id, 1);
    assert.equal(hello.event, "hello");
    assert.ok(hello.frame.type === "hello");
    assert.equal(hello.frame.apiVersion, 1);
    assert.deepEqual(hello.frame.scope, { kind: "session", sessionId: "s1" });
    assert.ok(hello.frame.serverTime >= before);
  });

  test("frames carry increasing ids and the frame type as the event name", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    sse.send({ type: "activity", items: [] });
    sse.send({ type: "activity", items: [] });
    assert.deepEqual(frames(res).map((f) => [f.id, f.event]), [[1, "hello"], [2, "activity"], [3, "activity"]]);
    assert.match(res.chunks[1], /^id: 2\nevent: activity\ndata: \{.*\}\n\n$/);
  });

  test("sendIfChanged skips a repeated frame per key and sends again when it changes", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    const a: Frame = { type: "activity", items: [] };
    const b: Frame = { type: "usage", usage: {} as never };
    sse.sendIfChanged("k", a);
    sse.sendIfChanged("k", a);
    assert.equal(frames(res).length, 2);
    sse.sendIfChanged("k", b);
    sse.sendIfChanged("k", a);
    assert.equal(frames(res).length, 4, "back to a counts as a change");
    sse.sendIfChanged("other", a);
    assert.equal(frames(res).length, 5, "keys are independent");
  });

  test("closing the connection stops the heartbeat, runs cleanups once and silences send", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    let cleaned = 0;
    sse.onClose(() => cleaned++);
    sse.onClose(() => cleaned++);
    assert.equal(sse.closed, false);
    res.emit("close");
    res.emit("close");
    assert.equal(sse.closed, true);
    assert.equal(cleaned, 2, "each cleanup ran exactly once");
    const written = res.chunks.length;
    sse.send({ type: "activity", items: [] });
    sse.sendIfChanged("k", { type: "activity", items: [] });
    assert.equal(res.chunks.length, written);
  });

  test("a cleanup that throws does not stop the others", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    const ran: string[] = [];
    sse.onClose(() => ran.push("first"));
    sse.onClose(() => {
      throw new Error("cleanup failed");
    });
    sse.onClose(() => ran.push("third"));
    res.emit("close");
    assert.deepEqual(ran, ["first", "third"]);
  });

  test("onClose after the stream closed runs the callback at once", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    res.emit("close");
    let ran = false;
    sse.onClose(() => (ran = true));
    assert.equal(ran, true);
  });

  test("a comment line keeps idle connections alive every 15 seconds, and stops after close", (t) => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { res } = open(t, { kind: "device" });
      mock.timers.tick(14_999);
      assert.equal(res.chunks.filter((c) => c === ": ping\n\n").length, 0);
      mock.timers.tick(1);
      assert.equal(res.chunks.filter((c) => c === ": ping\n\n").length, 1);
      mock.timers.tick(30_000);
      assert.equal(res.chunks.filter((c) => c === ": ping\n\n").length, 3);
      res.emit("close");
      mock.timers.tick(60_000);
      assert.equal(res.chunks.filter((c) => c === ": ping\n\n").length, 3);
    } finally {
      mock.timers.reset();
    }
  });

  test("a viewer whose buffer passes 2 MB is ended, not buffered", (t) => {
    const { res, sse } = open(t, { kind: "device" });
    res.writableLength = 2_000_000;
    sse.send({ type: "activity", items: [] });
    assert.equal(res.ended, false, "exactly at the limit is still fine");
    res.writableLength = 2_000_001;
    sse.send({ type: "activity", items: [] });
    assert.equal(res.ended, true);
    assert.equal(sse.closed, true);
  });
});

describe("coalesce", () => {
  test("many triggers inside the window run the function once", async () => {
    let runs = 0;
    const push = coalesce(async () => void runs++, 20);
    push();
    push();
    push();
    assert.equal(runs, 0, "never synchronously");
    await delay(60);
    assert.equal(runs, 1);
  });

  test("a trigger while running schedules exactly one catch-up run, never a concurrent one", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const push = coalesce(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      runs++;
      await delay(60);
      running--;
    }, 10);
    push();
    await delay(30); // first run is in flight
    push();
    push();
    push();
    await delay(250);
    assert.equal(runs, 2);
    assert.equal(maxRunning, 1);
  });

  test("now() runs immediately without waiting for the window", async () => {
    let runs = 0;
    const push = coalesce(async () => void runs++, 10_000);
    await push.now();
    assert.equal(runs, 1);
  });

  test("cancel() drops a pending run", async () => {
    let runs = 0;
    const push = coalesce(async () => void runs++, 20);
    push();
    push.cancel();
    await delay(60);
    assert.equal(runs, 0);
  });

  test("an error is logged and later triggers still run", async () => {
    const logged: unknown[][] = [];
    const spy = mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    try {
      let runs = 0;
      const push = coalesce(async () => {
        runs++;
        if (runs === 1) throw new Error("update failed");
      }, 10);
      await push.now();
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /stream update failed/);
      assert.equal(logged[0][1], "update failed");
      await push.now();
      assert.equal(runs, 2);
    } finally {
      spy.mock.restore();
    }
  });
});

describe("parseDocs", () => {
  const allowed = ["app.shared-state", "demo.job-runs"];

  test("nothing requested means no documents", () => {
    assert.deepEqual(parseDocs(undefined, allowed), []);
    assert.deepEqual(parseDocs("", allowed), []);
  });

  test("splits on commas, trims, drops empties and repeats, keeps order", () => {
    assert.deepEqual(parseDocs("demo.job-runs, app.shared-state ,,demo.job-runs", allowed), ["demo.job-runs", "app.shared-state"]);
  });

  test("an unknown kind is a 400 that lists the allowed kinds", () => {
    assert.throws(
      () => parseDocs("demo.job-runs,nope", allowed),
      (e: { status: number; code: string; message: string }) =>
        e.status === 400 && e.code === "invalid" && e.message === "Unknown document nope. Allowed: app.shared-state, demo.job-runs",
    );
  });

  test("anything but a string (a repeated ?docs= parameter parses to an array) is a 400", () => {
    assert.throws(() => parseDocs(["a", "b"], allowed), /comma-separated list/);
    assert.throws(() => parseDocs({ a: 1 }, allowed), /comma-separated list/);
    assert.throws(() => parseDocs(5, allowed), /comma-separated list/);
  });
});

describe("diffActivity", () => {
  const agent = (id: number, busy: boolean) => ({ id, name: `a${id}`, named: false, kind: "root" as const, busy, background: 0 });
  const session = (id: string, ...agents: ReturnType<typeof agent>[]) => ({ id, name: id, agents }) as unknown as SessionSummary;
  const tree = (at: number, ...sessions: SessionSummary[]): DeviceTree => ({ uid: "u", name: "d", sessions, at });

  test("the first tree has nothing to compare with", () => {
    assert.deepEqual(diffActivity(undefined, tree(1, session("s", agent(1, true)))), []);
  });

  test("reports an agent that became busy or idle, stamped with the new tree's time", () => {
    const idle = tree(1, session("s", agent(1, false)));
    const busy = tree(2, session("s", agent(1, true)));
    assert.deepEqual(diffActivity(idle, busy), [{ type: "agent.started", sessionId: "s", agentId: 1, at: 2 }]);
    assert.deepEqual(diffActivity(busy, tree(3, session("s", agent(1, false)))), [{ type: "agent.finished", sessionId: "s", agentId: 1, at: 3 }]);
  });

  test("unchanged agents report nothing", () => {
    const t = tree(1, session("s", agent(1, true), agent(2, false)));
    assert.deepEqual(diffActivity(t, tree(2, session("s", agent(1, true), agent(2, false)))), []);
  });

  test("a new agent or session counts as idle before, so a busy newcomer started", () => {
    const before = tree(1, session("s", agent(1, false)));
    const after = tree(2, session("s", agent(1, false), agent(2, true)), session("t", agent(1, true)));
    assert.deepEqual(diffActivity(before, after), [
      { type: "agent.started", sessionId: "s", agentId: 2, at: 2 },
      { type: "agent.started", sessionId: "t", agentId: 1, at: 2 },
    ]);
    assert.deepEqual(diffActivity(before, tree(3, session("s", agent(1, false), agent(2, false)))), [], "an idle newcomer is silent");
  });

  test("a vanished busy agent is not reported as finished", () => {
    assert.deepEqual(diffActivity(tree(1, session("s", agent(1, true))), tree(2, session("s"))), []);
  });

  test("agents with the same id in different sessions are told apart", () => {
    const before = tree(1, session("s", agent(1, false)), session("t", agent(1, true)));
    const after = tree(2, session("s", agent(1, true)), session("t", agent(1, false)));
    assert.deepEqual(diffActivity(before, after), [
      { type: "agent.started", sessionId: "s", agentId: 1, at: 2 },
      { type: "agent.finished", sessionId: "t", agentId: 1, at: 2 },
    ]);
  });
});
