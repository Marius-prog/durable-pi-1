// REST v1: messages, submissions, withdrawing, aborting, entries, transcripts, fork, tasks.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { delay, until } from "./helpers.js";
import { startRest } from "./rest.js";

describe("REST v1: messages, entries and tasks", () => {
  let rest: Awaited<ReturnType<typeof startRest>>;
  before(async () => void (rest = await startRest()));
  after(() => rest?.stop());
  const call = (...args: Parameters<typeof rest.call>) => rest.call(...args);
  const errorOf = (...args: Parameters<typeof rest.errorOf>) => rest.errorOf(...args);
  const newSession = () => rest.newSession();
  const ask = (...args: Parameters<typeof rest.ask>) => rest.ask(...args);

  describe("sending", () => {
    test("send validates content, requestId and whenBusy, and submits nothing when it refuses", async () => {
      const s = await newSession();
      const url = `${s.main}/messages`;
      const content = "content must be a message under 100,000 characters";
      errorOf(await call("POST", url, { requestId: "a" }), 400, "invalid", content);
      errorOf(await call("POST", url, { content: "", requestId: "a" }), 400, "invalid", content);
      errorOf(await call("POST", url, { content: "   ", requestId: "a" }), 400, "invalid", content);
      errorOf(await call("POST", url, { content: 5, requestId: "a" }), 400, "invalid", content);
      errorOf(await call("POST", url, { content: "x".repeat(100_001), requestId: "a" }), 400, "invalid", content);
      const request = /requestId is required/;
      errorOf(await call("POST", url, { content: "x" }), 400, "invalid", request);
      errorOf(await call("POST", url, { content: "x", requestId: "" }), 400, "invalid", request);
      errorOf(await call("POST", url, { content: "x", requestId: 5 }), 400, "invalid", request);
      errorOf(await call("POST", url, { content: "x", requestId: "r".repeat(129) }), 400, "invalid", request);
      errorOf(await call("POST", url, { content: "x", requestId: "a", whenBusy: "later" }), 400, "invalid", "whenBusy must be followUp, steer or reject");
      const users = (await call("GET", `${s.main}/entries`)).body.items.filter((e: { kind: string }) => e.kind === "pi.user");
      assert.equal(users.length, 0);
    });

    test("the longest allowed content and requestId are accepted", async () => {
      const s = await newSession();
      const r = await call("POST", `${s.main}/messages`, { content: "ok", requestId: "r".repeat(128), waitMs: 15000 });
      assert.equal(r.status, 200);
      assert.equal(r.body.answer.text, "Echo: ok");
    });

    test("without waitMs the answer is 202 queued; with it the answer comes back in the same request", async () => {
      const s = await newSession();
      const queued = await call("POST", `${s.main}/messages`, { content: "later", requestId: "q-1" });
      assert.equal(queued.status, 202);
      assert.equal(queued.body.status, "queued");
      assert.equal(typeof queued.body.submissionId, "number");
      const waited = await call("GET", `${s.base}/submissions/${queued.body.submissionId}?waitMs=15000`);
      assert.equal(waited.status, 200);
      assert.equal(waited.body.status, "done");
      assert.equal(waited.body.answer.text, "Echo: later");
      assert.equal((await call("POST", `${s.main}/messages`, { content: "a", requestId: "q-2", waitMs: "soon" })).status, 202, "a non-numeric wait is no wait");
      assert.equal((await call("POST", `${s.main}/messages`, { content: "a", requestId: "q-3", waitMs: 0 })).status, 202);
    });

    test("a wait that times out answers 202 pending, and the run keeps going", async () => {
      const s = await newSession();
      const r = await call("POST", `${s.main}/messages`, { content: "!sleep 1; echo slept", requestId: "p-1", waitMs: 200 });
      assert.equal(r.status, 202);
      assert.equal(r.body.status, "pending");
      assert.equal((await call("GET", `${s.base}/submissions/${r.body.submissionId}?waitMs=20000`)).body.status, "done");
    });

    test("an unknown or malformed submission id", async () => {
      const s = await newSession();
      errorOf(await call("GET", `${s.base}/submissions/99999`), 404, "not_found", "No submission 99999");
      errorOf(await call("GET", `${s.base}/submissions/abc`), 400, "invalid", "submission id must be an integer");
      errorOf(await call("GET", `${s.base}/submissions/1.5`), 400, "invalid", "submission id must be an integer");
    });

    test("a repeated requestId returns the same submission and runs once", async () => {
      const s = await newSession();
      const a = await call("POST", `${s.main}/messages`, { content: "once", requestId: "same", waitMs: 15000 });
      const b = await call("POST", `${s.main}/messages`, { content: "once", requestId: "same", waitMs: 15000 });
      assert.equal(a.body.submissionId, b.body.submissionId);
      const users = (await call("GET", `${s.main}/entries?scope=active`)).body.items.filter((e: { kind: string }) => e.kind === "pi.user");
      assert.equal(users.length, 1);
    });

    test("a queued follow-up can be withdrawn before it is placed; a settled or unknown one cannot", async () => {
      const s = await newSession();
      const running = await call("POST", `${s.main}/messages`, { content: "!sleep 2; echo first", requestId: "w-1" });
      await until(async () => rest.busy(s), 10000, "agent busy");
      const second = await call("POST", `${s.main}/messages`, { content: "second message", requestId: "w-2" });
      assert.equal(second.status, 202);
      assert.deepEqual((await call("DELETE", `${s.main}/inbox/${second.body.submissionId}`)).body, { status: "aborted" });
      assert.deepEqual((await call("DELETE", `${s.main}/inbox/99999`)).body, { status: "not_found" });
      errorOf(await call("DELETE", `${s.main}/inbox/abc`), 400, "invalid", "submissionId must be an integer");
      await call("GET", `${s.base}/submissions/${running.body.submissionId}?waitMs=20000`);
      await until(async () => !(await rest.busy(s)), 10000, "agent idle");
      const md = (await call("GET", `${s.main}/transcript?format=markdown`)).body.text as string;
      assert.match(md, /first/);
      assert.doesNotMatch(md, /second message/);
      assert.deepEqual((await call("DELETE", `${s.main}/inbox/${running.body.submissionId}`)).body, { status: "settled" });
    });
  });

  describe("abort", () => {
    test("abort answers ok whether or not anything runs, with or without background", async () => {
      const s = await newSession();
      assert.deepEqual((await call("POST", `${s.main}/abort`)).body, { ok: true });
      assert.deepEqual((await call("POST", `${s.main}/abort`, { background: true })).body, { ok: true });
      assert.deepEqual((await call("POST", `${s.main}/abort`, { background: "yes" })).body, { ok: true });
    });

    test("aborting a running command stops it, and the agent becomes idle without running the rest", async () => {
      const s = await newSession();
      await call("POST", `${s.main}/messages`, { content: "!sleep 30; echo never-printed", requestId: "ab-1" });
      await until(async () => rest.busy(s), 10000, "busy");
      await delay(500);
      await call("POST", `${s.main}/abort`);
      await until(async () => !(await rest.busy(s)), 15000, "idle after abort");
      const md = (await call("GET", `${s.main}/transcript?format=markdown`)).body.text as string;
      assert.match(md, /Tool bash was aborted/);
      assert.doesNotMatch(md, /```\nnever-printed/, "the echo after the sleep never ran");
    });

    test("aborting one task: a bad id is 400, an unknown id is 404, a live task is marked", async () => {
      const s = await newSession();
      errorOf(await call("POST", `${s.base}/tasks/abc/abort`), 400, "invalid", "taskId must be an integer");
      errorOf(await call("POST", `${s.base}/tasks/99999/abort`), 404, "not_found", "No task 99999");
      await call("POST", `${s.main}/messages`, { content: "!sleep 30", requestId: "t-1" });
      let tool: { id: number } | undefined;
      await until(async () => {
        tool = ((await call("GET", `${s.base}/tasks?status=live`)).body as { id: number; label?: string }[]).find((x) => x.label === "bash");
        return !!tool;
      }, 10000, "live bash task");
      const aborted = await call("POST", `${s.base}/tasks/${tool!.id}/abort`);
      assert.equal(aborted.status, 200);
      assert.ok(["marked", "terminal"].includes(aborted.body.status));
      await until(async () => !(await rest.busy(s)), 20000, "idle after task abort");
    });
  });

  describe("entries and transcript", () => {
    test("pagination walks every entry exactly once and the cursor is opaque", async () => {
      const s = await newSession();
      for (const word of ["one", "two", "three"]) await ask(s.main, word);
      const all = (await call("GET", `${s.main}/entries?limit=500`)).body;
      assert.ok(all.items.length >= 6);
      assert.equal(all.next, undefined);
      const seen: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = (await call("GET", `${s.main}/entries?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
        assert.ok(page.items.length <= 2);
        seen.push(...page.items.map((e: { id: number }) => e.id));
        cursor = page.next;
        pages++;
      } while (cursor && pages < 50);
      assert.equal(new Set(seen).size, seen.length, "no entry twice");
      const ids = all.items.map((e: { id: number }) => e.id);
      assert.deepEqual(seen.slice().sort((a, b) => a - b), ids.slice().sort((a: number, b: number) => a - b));
      assert.ok(pages > 1);
    });

    test("a reset leaves a marker entry, keeps the stored history and lets the conversation continue", async () => {
      const s = await newSession();
      await ask(s.main, "before reset");
      await call("POST", `${s.main}/reset`, { note: "start over" });
      await ask(s.main, "after reset");
      const active = (await call("GET", `${s.main}/entries?scope=active`)).body.items as { kind: string }[];
      const all = JSON.stringify((await call("GET", `${s.main}/entries`)).body.items);
      assert.ok(active.some((e) => e.kind === "pi.reset"));
      assert.ok(all.includes("before reset") && all.includes("after reset"), "nothing stored is lost");
    });

    test("a cursor that is not one of ours is a 400", async () => {
      const s = await newSession();
      errorOf(await call("GET", `${s.main}/entries?cursor=***`), 400, "invalid", "Invalid cursor");
      errorOf(await call("GET", `${s.main}/entries?cursor=${Buffer.from("not json").toString("base64url")}`), 400, "invalid", "Invalid cursor");
    });

    test("numeric limits are clamped to 1..2000", async () => {
      const s = await newSession();
      await ask(s.main, "hello");
      assert.equal((await call("GET", `${s.main}/entries?limit=0`)).body.items.length, 1);
      assert.equal((await call("GET", `${s.main}/entries?limit=-5`)).body.items.length, 1);
      assert.ok((await call("GET", `${s.main}/entries?limit=99999`)).body.items.length >= 3);
    });

    // SUSPECTED BUG: a non-numeric limit reaches SQLite as NaN and the client gets 500 "datatype mismatch".
    // It should be a 400 or fall back to the default. The test states the expected behaviour.
    test("a non-numeric limit is a client error, not a 500", { todo: "suspected bug: GET /entries?limit=abc answers 500 'datatype mismatch'" }, async () => {
      const s = await newSession();
      const r = await call("GET", `${s.main}/entries?limit=abc`);
      assert.ok(r.status === 400 || r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
    });

    test("transcript is json by default, markdown on request, and unknown formats fall back to json", async () => {
      const s = await newSession();
      await ask(s.main, "greetings");
      const json = (await call("GET", `${s.main}/transcript`)).body;
      assert.equal(json.format, "json");
      assert.deepEqual(json.items.map((i: { kind: string }) => i.kind), ["user", "assistant"]);
      const md = (await call("GET", `${s.main}/transcript?format=markdown`)).body;
      assert.equal(md.format, "markdown");
      assert.match(md.text, /### You \(#\d+\)\n\ngreetings/);
      assert.match(md.text, /### Agent \(#\d+\)\n\nEcho: greetings/);
      assert.equal((await call("GET", `${s.main}/transcript?format=xml`)).body.format, "json");
    });

    test("an empty agent has an empty transcript", async () => {
      const s = await newSession();
      assert.deepEqual((await call("GET", `${s.main}/transcript`)).body, { format: "json", items: [] });
      assert.equal((await call("GET", `${s.main}/transcript?format=markdown`)).body.text.trim(), "");
    });
  });

  describe("fork", () => {
    test("needs an integer entryId and a string name", async () => {
      const s = await newSession();
      await ask(s.main, "hello");
      errorOf(await call("POST", `${s.main}/fork`, {}), 400, "invalid", "entryId is required");
      errorOf(await call("POST", `${s.main}/fork`, { entryId: "abc" }), 400, "invalid", "entryId is required");
      errorOf(await call("POST", `${s.main}/fork`, { entryId: 1.5 }), 400, "invalid", "entryId is required");
      const entry = (await call("GET", `${s.main}/entries?scope=active`)).body.items.at(-1);
      errorOf(await call("POST", `${s.main}/fork`, { entryId: entry.id, name: 5 }), 400, "invalid", "Invalid fork name");
    });

    // SUSPECTED BUG: an entry id that is not in this agent's history makes the fork answer 500 with the engine's message.
    // A caller mistake like this should be a 4xx. The test states the expected behaviour.
    test("forking at an entry that does not exist is a client error, not a 500", { todo: "suspected bug: POST /fork with an unknown entryId answers 500 'Entry N is not visible from conversation 1'" }, async () => {
      const s = await newSession();
      await ask(s.main, "hello");
      const r = await call("POST", `${s.main}/fork`, { entryId: 99999 });
      assert.ok(r.status === 400 || r.status === 404, `status ${r.status}: ${JSON.stringify(r.body)}`);
    });

    test("a fork carries history up to the entry and not beyond", async () => {
      const s = await newSession();
      await ask(s.main, "first topic");
      const firstReply = (await call("GET", `${s.main}/entries?scope=active`)).body.items.find((e: { kind: string }) => e.kind === "pi.assistant");
      await ask(s.main, "second topic");
      const fork = await call("POST", `${s.main}/fork`, { entryId: firstReply.id, name: "Branch" });
      assert.equal(fork.status, 201);
      assert.equal(fork.body.kind, "fork");
      assert.equal(fork.body.name, "Branch");
      const md = (await call("GET", `${s.base}/agents/${fork.body.id}/transcript?format=markdown`)).body.text as string;
      assert.match(md, /first topic/);
      assert.doesNotMatch(md, /second topic/);
      assert.equal((await call("GET", `${s.base}/agents`)).body.find((a: { id: number }) => a.id === fork.body.id).parentId, 1);
    });

    test("an unnamed fork is called Fork #id and can still be reached by that name", async () => {
      const s = await newSession();
      await ask(s.main, "hello");
      const entry = (await call("GET", `${s.main}/entries?scope=active`)).body.items.at(-1);
      const fork = await call("POST", `${s.main}/fork`, { entryId: entry.id });
      assert.equal(fork.body.name, `Fork #${fork.body.id}`);
      assert.equal(fork.body.named, false);
      assert.equal((await call("GET", `${s.base}/agents/${encodeURIComponent(fork.body.name)}`)).body.id, fork.body.id);
    });
  });

  describe("tasks and inspect", () => {
    test("status must be live or terminal; terminal lists finished work newest first", async () => {
      const s = await newSession();
      errorOf(await call("GET", `${s.base}/tasks?status=done`), 400, "invalid", "status must be live or terminal");
      assert.deepEqual((await call("GET", `${s.base}/tasks?status=live`)).body, []);
      await ask(s.main, "one");
      await ask(s.main, "two");
      const tasks = (await call("GET", `${s.base}/tasks`)).body as { id: number; state: { status: string } }[];
      assert.ok(tasks.length >= 2);
      assert.ok(tasks.every((x) => x.state.status === "terminal"));
      assert.deepEqual(tasks.map((x) => x.id), tasks.map((x) => x.id).sort((a, b) => b - a), "newest first");
      assert.equal((await call("GET", `${s.base}/tasks?limit=1`)).body.length, 1);
      assert.equal((await call("GET", `${s.base}/tasks?limit=0`)).body.length, 1, "limit is at least 1");
    });

    test("inspect reports the scheduler state", async () => {
      const s = await newSession();
      const r = await call("GET", `${s.base}/inspect`);
      assert.equal(r.status, 200);
      assert.equal(r.body.scheduling, "running");
      assert.deepEqual(r.body.tasks, []);
    });
  });
});
