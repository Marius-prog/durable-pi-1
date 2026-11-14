// The composer's slash commands (commands.ts): parsing, and what each command sends to the device
// through the hub proxy. The fake fetch records every request.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  B,
  T,
  agentOf,
  browser,
  fetched,
  m,
  open,
  resetClient,
  snapshot,
  teardownClient,
  toast,
} from "./client-fixture.js";

after(teardownClient);
beforeEach(resetClient);

describe("parseCommand", () => {
  test("a known command with and without an argument", () => {
    const { parseCommand } = m.commands;
    assert.equal(parseCommand("/compact")?.command.name, "compact");
    assert.equal(parseCommand("/compact")?.arg, "");
    const withArg = parseCommand("/compact focus on the bug");
    assert.deepEqual([withArg?.command.name, withArg?.arg], ["compact", "focus on the bug"]);
  });

  test("surrounding space is trimmed and the argument keeps its inner spacing and newlines", () => {
    const { parseCommand } = m.commands;
    assert.equal(
      parseCommand("   /reset   a  note\nwith two lines  \n")?.arg,
      "a  note\nwith two lines",
    );
    assert.equal(parseCommand("/reset\nnote on the next line")?.arg, "note on the next line");
  });

  test("anything that is not a known command is not a command", () => {
    const { parseCommand } = m.commands;
    for (const text of [
      "",
      " ",
      "hello",
      "hello /compact",
      "/",
      "/ compact",
      "/unknown",
      "/Compact",
      "//compact",
      "/compact2",
    ])
      assert.equal(parseCommand(text), undefined, JSON.stringify(text));
  });

  test("the list matches the terminal client's names, once each", () => {
    const names = m.commands.commands.map((c) => c.name);
    assert.deepEqual([...names].sort(), [
      "compact",
      "fork",
      "help",
      "model",
      "name",
      "new",
      "reset",
      "tasks",
      "thinking",
    ]);
    assert.equal(new Set(names).size, names.length);
    for (const c of m.commands.commands) assert.ok(c.description.length > 5, c.name);
  });

  test("/thinking lists the levels the SDK knows", () => {
    const thinking = m.commands.commands.find((c) => c.name === "thinking")!;
    assert.match(thinking.description, /off, minimal, low, medium, high, xhigh/);
  });
});

describe("slash commands", () => {
  const run = (text: string) => {
    const parsed = m.commands.parseCommand(text);
    assert.ok(parsed, `${text} is a command`);
    return parsed.command.run(parsed.arg);
  };
  /** run() may throw before it returns a promise (a sync error) or reject: treat both alike. */
  const failure = (text: string) => Promise.resolve().then(() => run(text));
  const lastBody = (method: string, url: string) => fetched(method, url).at(-1)?.body;

  test("every command that needs an agent or a workspace says so when none is selected", async () => {
    for (const text of ["/compact", "/reset", "/name x", "/thinking high"])
      await assert.rejects(failure(text), /No agent selected/, text);
    await assert.rejects(failure("/new"), /No workspace selected/);
    await assert.rejects(failure("/fork"), /Nothing to fork yet/);
    assert.equal(browser.fetch.calls.length, 0, "nothing was sent");
  });

  test("/compact sends the instructions, or nothing, and says where the outcome shows", async () => {
    await open();
    await run("/compact keep the schema");
    assert.deepEqual(lastBody("POST", `${B}/agents/1/compact`), {
      instructions: "keep the schema",
    });
    assert.equal(toast(), "Compaction requested. /tasks shows its outcome.");
    await run("/compact");
    assert.deepEqual(lastBody("POST", `${B}/agents/1/compact`), {}, "no instructions key at all");
  });

  test("/reset sends the handoff note, or nothing", async () => {
    await open();
    await run("/reset carry on with step 3");
    assert.deepEqual(lastBody("POST", `${B}/agents/1/reset`), { note: "carry on with step 3" });
    assert.equal(toast(), "New context started.");
    await run("/reset");
    assert.deepEqual(lastBody("POST", `${B}/agents/1/reset`), {});
  });

  test("a failing device call rejects, so the composer can show it", async () => {
    await open();
    browser.fetch.handler = () => ({
      status: 503,
      body: { error: { code: "unavailable", message: "Dev is offline" } },
    });
    await assert.rejects(failure("/compact"), /Dev is offline/);
    assert.equal(toast(), "", "no success toast");
  });

  test("/tasks opens the Tasks tab", async () => {
    await run("/tasks");
    assert.equal(m.store.ui.tab, "tasks");
    assert.equal(m.store.layout.inspector, true);
  });

  test("/model and /help open their dialogs", async () => {
    await run("/model");
    assert.equal(m.store.ui.dialog?.kind, "models");
    await run("/help");
    assert.equal(m.store.ui.dialog?.kind, "help");
  });

  test("/new creates an agent in this workspace, with the name if given, and selects it", async () => {
    await open();
    browser.fetch.handler = (c) =>
      c.method === "POST" && c.url === `${B}/agents`
        ? { body: agentOf(7, { name: "Scratch" }) }
        : {};
    await run("/new Scratch");
    const [call] = fetched("POST", `${B}/agents`);
    assert.deepEqual(call.body, { name: "Scratch" });
    assert.ok(call.headers["idempotency-key"], "creating is idempotent");
    assert.deepEqual(m.store.selected.value, { ...T, agentId: 7 });
    assert.equal(toast(), "New agent Scratch.");
    await run("/new");
    assert.deepEqual(fetched("POST", `${B}/agents`)[1].body, {});
  });

  test("/name renames, and needs a name", async () => {
    await open();
    await assert.rejects(failure("/name"), /Usage: \/name <name>/);
    assert.equal(fetched("PATCH", /./).length, 0);
    await run("/name Better name");
    assert.deepEqual(lastBody("PATCH", `${B}/agents/1`), { name: "Better name" });
    assert.equal(toast(), "Agent renamed to Better name.");
  });

  test("/thinking checks the level, sets it, reloads the agent and says when it applies", async () => {
    await open();
    await assert.rejects(failure("/thinking"), /Levels: off, minimal, low, medium, high, xhigh/);
    await assert.rejects(failure("/thinking extreme"), /Levels:/);
    assert.equal(fetched("PATCH", /./).length, 0, "an invalid level never reaches the device");
    browser.fetch.calls.length = 0;
    await run("/thinking high");
    assert.deepEqual(lastBody("PATCH", `${B}/agents/1/config`), { thinkingLevel: "high" });
    assert.ok(fetched("GET", `${B}/agents/1`).length >= 1, "the agent detail is refreshed");
    assert.equal(toast(), "Thinking high. Used on the next turn.");
  });

  describe("/fork", () => {
    const withEntries = async (kinds: string[]) => {
      const o = await open();
      o.agent(
        snapshot({
          entries: kinds.map((kind, i) => ({ id: (i + 1) * 10, conversationId: 1, kind })),
        }),
      );
      browser.fetch.handler = (c) =>
        c.method === "POST" && c.url.endsWith("/fork")
          ? { body: agentOf(8, { name: "Forked", kind: "fork", parentId: 1 }) }
          : {};
    };
    // A fork selects the new agent, so later commands in one test run against it.
    const forkBody = () => fetched("POST", /\/fork$/).at(-1)!.body;

    test("with no entry id it forks at the last assistant reply and selects the fork", async () => {
      await withEntries(["pi.user", "pi.assistant", "pi.user", "pi.assistant", "pi.user"]);
      await run("/fork");
      assert.deepEqual(forkBody(), { entryId: 40 });
      assert.deepEqual(m.store.selected.value, { ...T, agentId: 8 });
      assert.equal(toast(), "Forked at entry #40. App State stays shared.");
    });

    test("a number is the entry id and the rest is the name", async () => {
      await withEntries(["pi.assistant"]);
      await run("/fork 12 try the other way");
      assert.deepEqual(forkBody(), { entryId: 12, name: "try the other way" });
      await run("/fork 0");
      assert.deepEqual(forkBody(), { entryId: 0 }, "entry 0 is a real entry");
    });

    test("without a number the whole argument is the name", async () => {
      await withEntries(["pi.assistant"]);
      await run("/fork second take, shorter");
      assert.deepEqual(forkBody(), { entryId: 10, name: "second take, shorter" });
    });

    test("a number glued to letters is not an id", async () => {
      await withEntries(["pi.assistant"]);
      await run("/fork 12abc");
      assert.deepEqual(forkBody(), { entryId: 10, name: "12abc" });
    });

    test("the request is idempotent, so a double click forks once", async () => {
      await withEntries(["pi.assistant"]);
      await run("/fork");
      assert.ok(fetched("POST", `${B}/agents/1/fork`)[0].headers["idempotency-key"]);
    });

    test("with no assistant reply and no id there is nothing to fork", async () => {
      await withEntries(["pi.user", "pi.user"]);
      await assert.rejects(failure("/fork"), /Nothing to fork yet/);
      assert.equal(fetched("POST", /fork/).length, 0);
    });

    test("an explicit id works even with no replies yet", async () => {
      await withEntries([]);
      await run("/fork 3");
      assert.deepEqual(forkBody(), { entryId: 3 });
    });
  });
});
