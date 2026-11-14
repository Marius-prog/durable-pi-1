// REST v1: auth, unknown routes, request bodies, sessions, idempotent creates and compaction settings.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { faux } from "./helpers.js";
import { startRest } from "./rest.js";

describe("REST v1: sessions", () => {
  let rest: Awaited<ReturnType<typeof startRest>>;
  before(async () => void (rest = await startRest()));
  after(() => rest?.stop());
  const call = (...args: Parameters<typeof rest.call>) => rest.call(...args);
  const errorOf = (...args: Parameters<typeof rest.errorOf>) => rest.errorOf(...args);
  const newSession = (name?: string) => rest.newSession(name);

  describe("auth and unknown routes", () => {
    test("every /v1 route family answers 401 without the token, before the route is matched", async () => {
      const s = await newSession();
      const paths: [string, string][] = [
        ["GET", "/v1/device"],
        ["GET", "/v1/tree"],
        ["GET", "/v1/events"],
        ["GET", "/v1/fs/dirs"],
        ["GET", "/v1/docs/app.shared-state"],
        ["GET", "/v1/sessions"],
        ["POST", "/v1/sessions"],
        ["GET", s.base],
        ["GET", `${s.base}/events`],
        ["POST", `${s.main}/messages`],
        ["GET", "/v1/this-route-does-not-exist"],
      ];
      for (const [method, path] of paths) {
        const res = await fetch(rest.server.base + path, {
          method,
          headers: method === "POST" ? { "content-type": "application/json" } : {},
          body: method === "POST" ? "{}" : undefined,
        });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unauthorized");
      }
    });

    test("/healthz is open and says nothing about the device; Express is not advertised", async () => {
      const res = await fetch(`${rest.server.base}/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(res.headers.get("x-powered-by"), null);
    });

    test("unknown routes and wrong methods answer 404 with the error envelope", async () => {
      errorOf(await call("GET", "/v1/nope"), 404, "not_found", "Route not found");
      errorOf(await call("DELETE", "/v1/sessions"), 404, "not_found", "Route not found");
      errorOf(await call("PUT", "/v1/device", {}), 404, "not_found", "Route not found");
      const s = await newSession();
      errorOf(await call("GET", `${s.main}/nope`), 404, "not_found", "Route not found");
      const outside = await fetch(`${rest.server.base}/anything-else`);
      assert.equal(outside.status, 404);
      assert.equal(((await outside.json()) as { error: { code: string } }).error.code, "not_found");
    });
  });

  describe("request bodies", () => {
    test("malformed JSON is a 400 invalid", async () => {
      errorOf(await call("POST", "/v1/sessions", "{nope"), 400, "invalid", "Body must be valid JSON");
    });

    test("a body over 256 kB is refused as too large", async () => {
      const s = await newSession();
      errorOf(await call("POST", `${s.main}/messages`, { content: "x".repeat(300_000), requestId: "big" }), 400, "invalid", "Body too large");
    });

    test("a body that is not JSON is ignored, so required fields are reported missing", async () => {
      const res = await fetch(`${rest.server.base}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${rest.token}`, "content-type": "text/plain" },
        body: "name=x",
      });
      errorOf({ status: res.status, headers: res.headers, body: await res.json() }, 400, "invalid", "name is required");
    });

    test("a JSON array is not a session body, and a bare JSON string is refused by the parser", async () => {
      errorOf(await call("POST", "/v1/sessions", []), 400, "invalid", "name is required");
      errorOf(await call("POST", "/v1/sessions", '"just a string"'), 400, "invalid", "Body must be valid JSON");
    });
  });

  describe("sessions", () => {
    test("creating validates name, cwd, model and thinking level", async () => {
      const ok = { name: "N", cwd: rest.t.work, model: faux };
      const create = (patch: Record<string, unknown>) => call("POST", "/v1/sessions", { ...ok, ...patch });
      errorOf(await create({ name: undefined }), 400, "invalid", "name is required");
      errorOf(await create({ name: 5 }), 400, "invalid", "name is required");
      errorOf(await create({ cwd: undefined }), 400, "invalid", "cwd is required");
      errorOf(await create({ cwd: "   " }), 400, "invalid", "cwd is required");
      errorOf(await create({ cwd: join(rest.t.work, "missing") }), 400, "invalid", /must be an existing folder on routes-box/);
      errorOf(await create({ model: undefined }), 400, "invalid", "model must be { provider, modelId }");
      errorOf(await create({ model: "echo" }), 400, "invalid", "model must be { provider, modelId }");
      errorOf(await create({ model: { provider: "faux" } }), 400, "invalid", "model must be { provider, modelId }");
      errorOf(await create({ model: { provider: "faux", modelId: "gpt" } }), 400, "invalid", /Unknown model faux\/gpt/);
      errorOf(await create({ model: { provider: "openrouter", modelId: "echo" } }), 400, "invalid", /Unknown model openrouter\/echo/);
      errorOf(await create({ thinkingLevel: "extreme" }), 400, "invalid", "Invalid thinking level");
    });

    test("a relative cwd resolves against the first start dir, and the name is trimmed", async () => {
      const r = await call("POST", "/v1/sessions", { name: "  padded name  ", cwd: "project/nested", model: faux });
      assert.equal(r.status, 201);
      assert.equal(r.body.name, "padded name");
      assert.equal(r.body.cwd, join(rest.t.work, "project", "nested"));
    });

    test("a whitespace-only name becomes a placeholder on create, but rename is stricter", async () => {
      const r = await call("POST", "/v1/sessions", { name: "   ", cwd: rest.t.work, model: faux });
      assert.equal(r.status, 201);
      assert.equal(r.body.name, "Untitled session");
      errorOf(await call("PATCH", `/v1/sessions/${r.body.id}`, { name: "   " }), 400, "invalid", "A name is required");
    });

    test("names are cut to 100 characters on create and on rename", async () => {
      const r = await call("POST", "/v1/sessions", { name: "n".repeat(150), cwd: rest.t.work, model: faux });
      assert.equal(r.body.name.length, 100);
      assert.equal((await call("PATCH", `/v1/sessions/${r.body.id}`, { name: "m".repeat(150) })).body.name.length, 100);
    });

    test("an unknown session is 404, an id or a case-insensitive name finds it", async () => {
      const s = await newSession("Findable Name");
      errorOf(await call("GET", "/v1/sessions/does-not-exist"), 404, "not_found", /No session "does-not-exist" on routes-box/);
      errorOf(await call("GET", "/v1/sessions/00000000-0000-0000-0000-000000000000"), 404, "not_found");
      assert.equal((await call("GET", "/v1/sessions/FINDABLE%20NAME")).body.id, s.id);
      assert.equal((await call("GET", s.base)).body.id, s.id);
    });

    test("rename needs a non-empty string, and the old name stops resolving", async () => {
      const s = await newSession("Before");
      for (const body of [{}, { name: "" }, { name: "  " }, { name: 5 }, { name: null }])
        errorOf(await call("PATCH", s.base, body), 400, "invalid", "A name is required");
      assert.equal((await call("PATCH", s.base, { name: "  After  " })).body.name, "After");
      errorOf(await call("GET", "/v1/sessions/Before"), 404, "not_found");
      const r = await call("GET", "/v1/sessions/After");
      assert.equal(r.body.id, s.id);
      assert.deepEqual(r.body.agents.map((a: { id: number; name: string }) => [a.id, a.name]), [[1, "Main"]]);
      assert.equal(r.body.busy, false);
    });

    test("deleting archives: the session disappears and cannot be deleted twice", async () => {
      const s = await newSession("Doomed");
      const r = await call("DELETE", s.base);
      assert.equal(r.status, 200);
      assert.match(r.body.archived, /archive/);
      errorOf(await call("GET", s.base), 404, "not_found");
      errorOf(await call("DELETE", s.base), 404, "not_found");
      assert.ok(!(await call("GET", "/v1/sessions")).body.some((x: { id: string }) => x.id === s.id));
    });

    test("GET /v1/sessions and GET /v1/tree agree", async () => {
      await newSession();
      const list = (await call("GET", "/v1/sessions")).body as { id: string }[];
      const tree = (await call("GET", "/v1/tree")).body as { name: string; sessions: { id: string }[]; at: number };
      assert.deepEqual(tree.sessions.map((s) => s.id), list.map((s) => s.id));
      assert.equal(tree.name, "routes-box");
      assert.ok(tree.at > 0);
    });
  });

  describe("idempotent creates over HTTP", () => {
    test("the same key and route replays the same agent, and the replay is marked", async () => {
      const s = await newSession();
      const first = await call("POST", `${s.base}/agents`, { name: "twin" }, { "idempotency-key": "agent-key" });
      const second = await call("POST", `${s.base}/agents`, { name: "twin" }, { "idempotency-key": "agent-key" });
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(second.body.id, first.body.id);
      assert.equal(second.headers.get("idempotent-replay"), "true");
      assert.equal((await call("GET", `${s.base}/agents`)).body.length, 2, "one new agent, not two");
    });

    test("a key reused on another route is a 400, and an over-long key too", async () => {
      const s = await newSession();
      await call("POST", `${s.base}/agents`, {}, { "idempotency-key": "shared-key" });
      errorOf(await call("POST", "/v1/sessions", { name: "x", cwd: rest.t.work, model: faux }, { "idempotency-key": "shared-key" }), 400, "invalid", /different request/);
      errorOf(await call("POST", `${s.base}/agents`, {}, { "idempotency-key": "k".repeat(129) }), 400, "invalid", "Idempotency-Key too long");
    });

    test("a failed create is not remembered: fixing the body and retrying with the same key works", async () => {
      const key = { "idempotency-key": "retry-after-400" };
      errorOf(await call("POST", "/v1/sessions", { name: "Retry", cwd: join(rest.t.work, "missing"), model: faux }, key), 400, "invalid");
      assert.equal((await call("POST", "/v1/sessions", { name: "Retry", cwd: rest.t.work, model: faux }, key)).status, 201);
    });
  });

  describe("compaction settings", () => {
    test("GET returns the defaults for the model, PATCH merges and persists", async () => {
      const s = await newSession();
      const defaults = (await call("GET", `${s.base}/compaction`)).body;
      assert.equal(defaults.enabled, true);
      assert.ok(defaults.reserveTokens >= 1024);
      const patched = await call("PATCH", `${s.base}/compaction`, { keepRecentTokens: 3000, enabled: false });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.keepRecentTokens, 3000);
      assert.equal(patched.body.enabled, false);
      assert.equal(patched.body.reserveTokens, defaults.reserveTokens, "untouched fields keep their value");
      assert.deepEqual((await call("GET", `${s.base}/compaction`)).body, patched.body);
      assert.deepEqual((await call("GET", s.base)).body.compaction, patched.body);
    });

    test("every threshold is validated with its bounds in the message", async () => {
      const s = await newSession();
      const patch = (body: unknown) => call("PATCH", `${s.base}/compaction`, body);
      errorOf(await patch({ reserveTokens: 1023 }), 400, "invalid", "reserveTokens must be an integer from 1024 to 1000000");
      errorOf(await patch({ reserveTokens: 1_000_001 }), 400, "invalid", /reserveTokens/);
      errorOf(await patch({ reserveTokens: 2000.5 }), 400, "invalid", /reserveTokens/);
      errorOf(await patch({ reserveTokens: "lots" }), 400, "invalid", /reserveTokens/);
      errorOf(await patch({ backgroundTokens: -1 }), 400, "invalid", "backgroundTokens must be an integer from 0 to 1000000");
      errorOf(await patch({ keepRecentTokens: 499 }), 400, "invalid", "keepRecentTokens must be an integer from 500 to 200000");
      errorOf(await patch({ keepRecentTokens: 200_001 }), 400, "invalid", /keepRecentTokens/);
      errorOf(await patch({ enabled: "yes" }), 400, "invalid", "enabled must be a boolean");
      assert.equal((await patch({ backgroundTokens: 0 })).body.backgroundTokens, 0, "0 is allowed");
    });

    test("a rejected PATCH changes nothing, even for the fields that were valid", async () => {
      const s = await newSession();
      const before = (await call("GET", `${s.base}/compaction`)).body;
      errorOf(await call("PATCH", `${s.base}/compaction`, { reserveTokens: 5000, keepRecentTokens: 1 }), 400, "invalid");
      assert.deepEqual((await call("GET", `${s.base}/compaction`)).body, before);
    });
  });
});
