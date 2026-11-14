// REST v1: agents, agent config and the per-agent extensions.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { faux } from "./helpers.js";
import { startRest, type Reply } from "./rest.js";

describe("REST v1: agents, config and extensions", () => {
  let rest: Awaited<ReturnType<typeof startRest>>;
  before(async () => void (rest = await startRest()));
  after(() => rest?.stop());
  const call = (...args: Parameters<typeof rest.call>) => rest.call(...args);
  const errorOf = (...args: Parameters<typeof rest.errorOf>) => rest.errorOf(...args);
  const newSession = () => rest.newSession();
  const ask = (...args: Parameters<typeof rest.ask>) => rest.ask(...args);
  const dirNames = async (path: string) => ((await call("GET", `/v1/fs/dirs?path=${encodeURIComponent(path)}`)).body.dirs as { name: string }[]).map((d) => d.name);

  describe("agents", () => {
    test("agent refs: numeric id, main, derived name, custom name; a missing one is 404", async () => {
      const s = await newSession();
      const other = await call("POST", `${s.base}/agents`, { name: "Reviewer" });
      assert.equal((await call("GET", `${s.base}/agents/1`)).body.name, "Main");
      assert.equal((await call("GET", `${s.base}/agents/MAIN`)).body.id, 1);
      assert.equal((await call("GET", `${s.base}/agents/main`)).body.id, 1);
      assert.equal((await call("GET", `${s.base}/agents/reviewer`)).body.id, other.body.id);
      assert.equal((await call("GET", `${s.base}/agents/${other.body.id}`)).body.name, "Reviewer");
      errorOf(await call("GET", `${s.base}/agents/ghost`), 404, "not_found", /No agent "ghost" in session/);
      errorOf(await call("GET", `${s.base}/agents/999`), 404, "not_found", /No agent "999"/);
      errorOf(await call("GET", `/v1/sessions/ghost/agents/main`), 404, "not_found", /No session "ghost"/);
    });

    test("two agents with the same name make the name ambiguous; the id still works", async () => {
      const s = await newSession();
      const a = await call("POST", `${s.base}/agents`, { name: "Dup" });
      const b = await call("POST", `${s.base}/agents`, { name: "dup" });
      errorOf(await call("GET", `${s.base}/agents/dup`), 409, "ambiguous", /2 agents are named "dup"/);
      assert.equal((await call("GET", `${s.base}/agents/${a.body.id}`)).body.name, "Dup");
      assert.equal((await call("GET", `${s.base}/agents/${b.body.id}`)).body.name, "dup");
    });

    test("agent names cannot be blank, numeric, or 'main' for any agent but Main", async () => {
      const s = await newSession();
      const other = await call("POST", `${s.base}/agents`, {});
      const rename = (name: unknown) => call("PATCH", `${s.base}/agents/${other.body.id}`, { name });
      errorOf(await rename(""), 400, "invalid", "A name is required");
      errorOf(await rename("   "), 400, "invalid", "A name is required");
      errorOf(await rename(7), 400, "invalid", "A name is required");
      errorOf(await rename("42"), 400, "invalid", "Agent names cannot be numbers or 'main'");
      errorOf(await rename("Main"), 400, "invalid", "Agent names cannot be numbers or 'main'");
      errorOf(await rename(" main "), 400, "invalid", "Agent names cannot be numbers or 'main'");
      assert.equal((await rename("  Okay  ")).body.name, "Okay");
      assert.equal((await rename("n".repeat(150))).body.name.length, 100);
    });

    test("a new agent copies Main's model, instructions and folder; `from` picks another source", async () => {
      const s = await newSession();
      await call("PATCH", `${s.main}/config`, { instructions: "Answer in French.", thinkingLevel: "high" });
      const copy = await call("POST", `${s.base}/agents`, { name: "Copy" });
      const detail = (await call("GET", `${s.base}/agents/${copy.body.id}`)).body;
      assert.equal(detail.config.instructions, "Answer in French.");
      assert.equal(detail.config.thinkingLevel, "high");
      assert.equal(detail.config.cwd, rest.t.work);
      assert.equal(detail.config.model.modelId, "echo");
      await call("PATCH", `${s.base}/agents/${copy.body.id}/config`, { instructions: "Answer in Spanish." });
      const second = await call("POST", `${s.base}/agents`, { name: "Second", from: "Copy" });
      assert.equal((await call("GET", `${s.base}/agents/${second.body.id}`)).body.config.instructions, "Answer in Spanish.");
      errorOf(await call("POST", `${s.base}/agents`, { from: "nobody" }), 404, "not_found");
    });

    test("agent detail lists the tools with replay policy, parameters and write flags", async () => {
      const s = await newSession();
      const detail = (await call("GET", s.main)).body;
      const tool = (name: string) => detail.tools.find((x: { name: string }) => x.name === name);
      assert.equal(tool("bash").writes, true);
      assert.equal(tool("bash").replay, "unsafe");
      assert.equal(tool("read").writes, false);
      assert.equal(tool("read_state").replay, "safe");
      assert.equal(tool("ping_on_call_engineer").replay, "unsafe", "a real side effect is not replay-safe");
      assert.equal(tool("run_durable_job").writes, true);
      assert.equal(tool("search_history").writes, false);
      assert.equal(typeof tool("update_state").parameters, "object");
      assert.ok(detail.tools.every((x: { offered: boolean }) => x.offered), "nothing is hidden until read only is on");
      assert.equal(detail.sessionId, s.id);
      assert.deepEqual(detail.extensions.slice().sort(), ["coding-tools", "playground"]);
    });
  });

  describe("agent config", () => {
    test("each field is validated", async () => {
      const s = await newSession();
      const patch = (body: unknown) => call("PATCH", `${s.main}/config`, body);
      errorOf(await patch({ model: "echo" }), 400, "invalid", "model must be { provider, modelId }");
      errorOf(await patch({ model: { provider: "faux", modelId: "nope" } }), 400, "invalid", /Unknown model faux\/nope/);
      errorOf(await patch({ thinkingLevel: "max" }), 400, "invalid", "Invalid thinking level");
      errorOf(await patch({ instructions: 5 }), 400, "invalid", "instructions must be a string");
      errorOf(await patch({ cwd: 5 }), 400, "invalid", "cwd must be a string");
      errorOf(await patch({ cwd: join(rest.t.work, "missing") }), 404, "not_found", /Not a directory/);
      errorOf(await patch({ readOnly: "true" }), 400, "invalid", "readOnly must be a boolean");
      errorOf(await patch({ readOnly: 1 }), 400, "invalid", "readOnly must be a boolean");
    });

    test("valid changes apply and are returned; GET /config agrees", async () => {
      const s = await newSession();
      const patched = await call("PATCH", `${s.main}/config`, { thinkingLevel: "medium", instructions: "Be brief.", cwd: join(rest.t.work, "project"), model: faux });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.thinkingLevel, "medium");
      assert.equal(patched.body.instructions, "Be brief.");
      assert.equal(patched.body.cwd, join(rest.t.work, "project"));
      assert.deepEqual((await call("GET", `${s.main}/config`)).body, patched.body);
    });

    test("an empty patch changes nothing", async () => {
      const s = await newSession();
      const before = (await call("GET", `${s.main}/config`)).body;
      assert.deepEqual((await call("PATCH", `${s.main}/config`, {})).body, before);
    });

    test("instructions are cut to 12000 characters", async () => {
      const s = await newSession();
      const r = await call("PATCH", `${s.main}/config`, { instructions: "i".repeat(13_000) });
      assert.equal(r.body.instructions.length, 12_000);
    });

    test("the new working folder is where bash runs next", async () => {
      const s = await newSession();
      const nested = join(rest.t.work, "project", "nested");
      await call("PATCH", `${s.main}/config`, { cwd: nested });
      assert.ok((await ask(s.main, "!pwd")).includes(nested));
    });

    test("read only hides the writing tools; a bash request is refused and nothing is deleted", async () => {
      const s = await newSession();
      const victim = join(rest.t.work, "ro-kept");
      await mkdir(victim, { recursive: true });
      await call("PATCH", `${s.main}/config`, { readOnly: true });
      const detail = (await call("GET", s.main)).body;
      assert.ok(detail.tools.filter((x: { writes: boolean }) => x.writes).every((x: { offered: boolean }) => !x.offered));
      assert.equal(detail.config.readOnly, true);
      assert.match(await ask(s.main, `!rm -rf ${victim}`), /Tool bash is not available/);
      assert.ok((await dirNames(rest.t.work)).includes("ro-kept"));
    });
  });

  describe("extensions", () => {
    const flags = (r: Reply) => r.body.extensions.map((e: { enabled: boolean }) => e.enabled);

    test("both add-ons are listed, off by default, with the prompt checklist on system-prompts", async () => {
      const s = await newSession();
      const r = (await call("GET", `${s.main}/extensions`)).body;
      assert.deepEqual(r.extensions.map((e: { name: string; enabled: boolean }) => [e.name, e.enabled]), [["system-prompts", false], ["jev-damage-control", false]]);
      assert.deepEqual(r.builtIn.slice().sort(), ["coding-tools", "playground"]);
      assert.ok(r.extensions[0].prompts.length >= 2);
      assert.ok(r.extensions[0].prompts.every((p: { text: string }) => p.text.length > 0));
      assert.equal(r.extensions[1].prompts, undefined);
    });

    test("PATCH validates enabled, name and prompt", async () => {
      const s = await newSession();
      const patch = (body: unknown) => call("PATCH", `${s.main}/extensions`, body);
      errorOf(await patch({}), 400, "invalid", "enabled must be a boolean");
      errorOf(await patch({ name: "system-prompts" }), 400, "invalid", "enabled must be a boolean");
      errorOf(await patch({ name: "system-prompts", enabled: "yes" }), 400, "invalid", "enabled must be a boolean");
      errorOf(await patch({ enabled: true }), 400, "invalid", "name or prompt is required");
      errorOf(await patch({ name: 5, enabled: true }), 400, "invalid", "name or prompt is required");
      errorOf(await patch({ name: "nope", enabled: true }), 400, "invalid", /Unknown extension nope\. Known: system-prompts, jev-damage-control/);
      errorOf(await patch({ prompt: "nope.md", enabled: true }), 400, "invalid", /Unknown prompt nope\.md\. Known: /);
    });

    test("turning an add-on on or off twice is harmless, and it only affects that agent", async () => {
      const s = await newSession();
      const other = await call("POST", `${s.base}/agents`, { name: "Other" });
      const set = (agent: string | number, enabled: boolean) => call("PATCH", `${s.base}/agents/${agent}/extensions`, { name: "jev-damage-control", enabled });
      assert.deepEqual(flags(await set("main", true)), [false, true]);
      assert.deepEqual(flags(await set("main", true)), [false, true], "one copy, not two");
      assert.deepEqual(flags(await call("GET", `${s.base}/agents/${other.body.id}/extensions`)), [false, false]);
      assert.deepEqual(flags(await set("main", false)), [false, false]);
      assert.deepEqual(flags(await set("main", false)), [false, false]);
    });

    test("the prompt checklist is stored per agent in registry order", async () => {
      const s = await newSession();
      const prompts = (await call("GET", `${s.main}/extensions`)).body.extensions[0].prompts as { id: string; enabled: boolean }[];
      const [first, second] = prompts;
      assert.deepEqual([first.enabled, second.enabled], [true, false]);
      await call("PATCH", `${s.main}/extensions`, { prompt: second.id, enabled: true });
      await call("PATCH", `${s.main}/extensions`, { prompt: first.id, enabled: false });
      const after = (await call("GET", `${s.main}/extensions`)).body.extensions[0].prompts as { enabled: boolean }[];
      assert.deepEqual(after.map((p) => p.enabled).slice(0, 2), [false, true]);
    });

    test("jev-damage-control blocks rm -rf through the agent, and the folder survives", async () => {
      const s = await newSession();
      const victim = join(rest.t.work, "guarded");
      await mkdir(victim, { recursive: true });
      await call("PATCH", `${s.main}/extensions`, { name: "jev-damage-control", enabled: true });
      assert.match(await ask(s.main, `!rm -rf ${victim}`), /jev-damage-control blocked this command/);
      assert.ok((await dirNames(rest.t.work)).includes("guarded"));
    });
  });
});
