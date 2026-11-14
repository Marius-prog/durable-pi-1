// addons.ts: the system-prompts section and the jev-damage-control hook, run directly against stand-ins for the
// durable memo and snapshot APIs. Jev is reached only through a stubbed fetch.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import { ADDON_INFO, PROMPTS, PromptChecklist, createAddons } from "../src/addons.js";

const ctx = {} as Context;

type Verdict = { block: boolean; reason: string };
type Hook = (call: unknown, api: unknown, ctx: Context) => Promise<{ block?: string } | undefined>;

/** The extension's beforeTool handler, with an in-memory stand-in for the task's durable memo. */
function jevHook(offline: boolean) {
  const addons = createAddons({ offline });
  const hook = addons.all["jev-damage-control"].hooks![0];
  assert.equal(hook.task, "pi.tool");
  const handler = (hook.handlers as { beforeTool: Hook }).beforeTool;
  const memos = new Map<string, Verdict>();
  const api = {
    memo: async (name: string, a: unknown, b?: unknown) => {
      if (b === undefined) return memos.get(name);
      memos.set(name, a as Verdict);
      return a as Verdict;
    },
  };
  return { memos, run: (command: unknown, name = "bash") => handler({ name, arguments: command === undefined ? {} : { command } }, api, ctx) };
}

describe("registry of built-in prompts", () => {
  test("every prompt has an id ending in .md, a title, a description and trimmed non-empty text", () => {
    assert.ok(PROMPTS.length >= 2);
    assert.equal(new Set(PROMPTS.map((p) => p.id)).size, PROMPTS.length);
    for (const p of PROMPTS) {
      assert.match(p.id, /\.md$/);
      assert.ok(p.title && p.description);
      assert.ok(p.text.length > 0);
      assert.equal(p.text, p.text.trim());
    }
  });

  test("ADDON_INFO names exactly the two extensions createAddons builds, in the same order", () => {
    const addons = createAddons({ offline: true });
    assert.deepEqual(ADDON_INFO.map((a) => a.name), ["system-prompts", "jev-damage-control"]);
    assert.deepEqual(addons.list.map((e) => e.name), ADDON_INFO.map((a) => a.name));
    assert.deepEqual(Object.keys(addons.all), ADDON_INFO.map((a) => a.name));
    for (const info of ADDON_INFO) assert.ok(info.title && info.description);
  });

  test("the checklist document starts with only the first prompt enabled", () => {
    assert.equal(PromptChecklist.definition.kind, "ext.system-prompts");
    assert.deepEqual(PromptChecklist.definition.initial(), { enabled: [PROMPTS[0].id] });
  });
});

describe("system-prompts section", () => {
  const section = () => createAddons({ offline: true }).all["system-prompts"].sections![0];
  const render = (snapshot: { enabled: string[] } | undefined) =>
    section().render({ conversationId: 1, read: { snapshot: async () => snapshot } } as never, ctx);

  test("renders only the checked prompts, in registry order, separated by a blank line", async () => {
    const both = await render({ enabled: [PROMPTS[1].id, PROMPTS[0].id] });
    assert.equal(both, `${PROMPTS[0].text}\n\n${PROMPTS[1].text}`);
    assert.equal(await render({ enabled: [PROMPTS[1].id] }), PROMPTS[1].text);
  });

  test("falls back to the default checklist when the conversation has none yet", async () => {
    assert.equal(await render(undefined), PROMPTS[0].text);
  });

  test("renders nothing when every prompt is unchecked or the ids are unknown", async () => {
    assert.equal(await render({ enabled: [] }), undefined);
    assert.equal(await render({ enabled: ["gone.md"] }), undefined);
  });

  test("the section is untagged, so the prompt text goes in as written", () => {
    assert.equal(section().key, "system-prompts");
    assert.equal(section().tag, false);
  });
});

describe("jev-damage-control with the offline rules (faux provider)", () => {
  const blocked = [
    "rm -rf build",
    "rm -fr build",
    "rm -r dir",
    "rm -f file",
    "sudo rm -rf /",
    "cd x && rm -rf .",
    "git push origin main --force",
    "git push --force origin main",
    "git reset --hard HEAD~3",
    "dropdb production",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "truncate -s 0 data.db",
  ];
  const allowed = [
    "ls -la",
    "git status",
    "git push origin main",
    "git reset --soft HEAD~1",
    "rm file.txt",
    "echo rm",
    "npm test",
    "cat notes.md",
    "grep -r force .",
    "dd if=a.img",
  ];

  test("blocks destructive commands with a reason that names the rules", async () => {
    for (const command of blocked) {
      const h = jevHook(true);
      const result = await h.run(command);
      assert.ok(result?.block, `should block: ${command}`);
      assert.match(result.block, /^jev-damage-control blocked this command: destructive intent \(offline rules\)/);
    }
  });

  test("lets ordinary commands run", async () => {
    for (const command of allowed) {
      const h = jevHook(true);
      assert.equal(await h.run(command), undefined, `should allow: ${command}`);
    }
  });

  test("only bash is judged", async () => {
    const h = jevHook(true);
    assert.equal(await h.run("rm -rf /", "read"), undefined);
    assert.equal(await h.run("rm -rf /", "write"), undefined);
    assert.equal(h.memos.size, 0, "nothing was memoized for another tool");
  });

  test("a bash call with no command is allowed and judged as an empty command", async () => {
    const h = jevHook(true);
    assert.equal(await h.run(undefined), undefined);
    assert.deepEqual(h.memos.get("jev-damage-control"), { block: false, reason: "allowed (offline rules)" });
  });

  test("the decision is a memo: a stored verdict is reused and the command is not judged again", async () => {
    const h = jevHook(true);
    assert.equal(await h.run("ls"), undefined);
    assert.equal(h.memos.get("jev-damage-control")?.block, false);
    // Same task, replayed with a different command: the first decision stands.
    assert.equal(await h.run("rm -rf /"), undefined);
    h.memos.set("jev-damage-control", { block: true, reason: "earlier decision" });
    assert.deepEqual(await h.run("ls"), { block: "jev-damage-control blocked this command: earlier decision" });
  });
});

describe("jev-damage-control with Jev (stubbed fetch)", () => {
  const realFetch = globalThis.fetch;
  const keys = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  let requests: { url: string; body: { state: unknown; questions: Record<string, unknown> } }[];
  let respond: () => Response | Promise<Response>;

  const answers = (effect: string, confidence: number, destructive: number) => ({
    answers: {
      effect: { type: "choice", choice: effect, confidence, probabilities: { [effect]: confidence } },
      destructive_intent: { type: "noul", noul: destructive },
    },
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.TYPESAFE_API_KEY = "ts-fake-key";
    requests = [];
    respond = () => json(answers("read_only", 0.9, 0.0));
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return respond();
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("sends the command as state with the two bash-gate questions", async () => {
    const h = jevHook(false);
    await h.run("ls -la");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(requests[0].body.state, { command: "ls -la" });
    assert.deepEqual(Object.keys(requests[0].body.questions).sort(), ["destructive_intent", "effect"]);
    assert.equal((requests[0].body.questions.effect as { type: string }).type, "choice");
    assert.equal((requests[0].body.questions.destructive_intent as { type: string }).type, "noul");
  });

  test("a harmless verdict lets the command run and is memoized with its numbers", async () => {
    respond = () => json(answers("read_only", 0.91, 0.04));
    const h = jevHook(false);
    assert.equal(await h.run("ls"), undefined);
    assert.deepEqual(h.memos.get("jev-damage-control"), { block: false, reason: "read_only (0.91), destructive 0.04" });
  });

  test("a confident irreversible verdict blocks, naming the confidence", async () => {
    respond = () => json(answers("irreversible", 0.93, 0.2));
    const h = jevHook(false);
    const result = await h.run("rm -rf ~/proj");
    assert.match(result!.block!, /^jev-damage-control blocked this command: irreversible \(0\.93\): nothing would restore/);
    assert.equal(h.memos.get("jev-damage-control")?.block, true);
  });

  test("the irreversible threshold is 0.6, inclusive", async () => {
    const run = async (confidence: number) => {
      respond = () => json(answers("irreversible", confidence, 0.1));
      return jevHook(false).run("x");
    };
    assert.ok((await run(0.6))?.block, "0.60 blocks");
    assert.equal(await run(0.59), undefined, "0.59 runs");
  });

  test("the destructive-intent threshold is 0.7, inclusive, whatever the effect says", async () => {
    const run = async (noul: number) => {
      respond = () => json(answers("reversible", 0.9, noul));
      return jevHook(false).run("x");
    };
    const blocked = await run(0.7);
    assert.match(blocked!.block!, /destructive intent \(0\.70\): this command aims to wipe something/);
    assert.equal(await run(0.69), undefined);
  });

  test("a reversible effect never blocks on its own", async () => {
    respond = () => json(answers("reversible", 1, 0.1));
    assert.equal(await jevHook(false).run("npm install"), undefined);
  });

  test("irreversible below the confidence bar with low intent still runs", async () => {
    respond = () => json(answers("irreversible", 0.4, 0.3));
    assert.equal(await jevHook(false).run("git push"), undefined);
  });

  test("it fails open: a Jev outage, bad status or malformed answer lets the command run and stores no verdict", async () => {
    const outages: Array<() => Response | Promise<Response>> = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ error: "nope" }, 500),
      () => json({ answers: {} }),
      () => new Response("<html>", { status: 200 }),
    ];
    for (const outage of outages) {
      respond = outage;
      const h = jevHook(false);
      assert.equal(await h.run("rm -rf /"), undefined);
      assert.equal(h.memos.size, 0, "a failed judgement is not memoized, so a replay asks again");
    }
  });

  test("with no Jev credentials at all it fails open too", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const h = jevHook(false);
    assert.equal(await h.run("rm -rf /"), undefined);
    assert.equal(requests.length, 0);
  });

  test("a memoized verdict means Jev is not asked again", async () => {
    const h = jevHook(false);
    await h.run("ls");
    await h.run("ls");
    assert.equal(requests.length, 1);
  });

  test("only bash reaches Jev", async () => {
    const h = jevHook(false);
    await h.run("rm -rf /", "edit");
    assert.equal(requests.length, 0);
  });
});
