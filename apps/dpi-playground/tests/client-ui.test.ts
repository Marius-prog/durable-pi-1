// store.ts chrome: toasts, errors, formatting helpers, interrupt, and the panel layout and hotkeys.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, loadClient } from "./client-env.js";
import {
  B,
  agentOf,
  browser,
  fetched,
  m,
  modelInfo,
  open,
  resetClient,
  snapshot,
  teardownClient,
  toast,
} from "./client-fixture.js";
import { delay, until } from "./support.js";

after(teardownClient);
beforeEach(resetClient);

describe("toasts and errors", () => {
  test("notify() shows a message for 4.5 seconds, and a newer one restarts the clock", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    m.store.notify("first");
    assert.equal(toast(), "first");
    t.mock.timers.tick(3000);
    m.store.notify("second");
    t.mock.timers.tick(3000);
    assert.equal(toast(), "second", "the first timer was cancelled");
    t.mock.timers.tick(1499);
    assert.equal(toast(), "second");
    t.mock.timers.tick(1);
    assert.equal(toast(), "");
  });

  test("attempt() returns the result and clears the previous error", async () => {
    m.store.ui.error = "old";
    assert.equal(await m.store.attempt(async () => 42), 42);
    assert.equal(m.store.ui.error, "");
  });

  test("attempt() turns a failure into the on-screen error and undefined", async () => {
    assert.equal(await m.store.attempt(() => Promise.reject(new Error("it broke"))), undefined);
    assert.equal(m.store.ui.error, "it broke");
    assert.equal(await m.store.attempt(() => Promise.reject("just text")), undefined);
    assert.equal(m.store.ui.error, "just text");
  });

  test("preset() fills the composer and focuses it on the next tick", async () => {
    const hit = browser.document.add(".composer textarea");
    m.store.preset("/fork ");
    assert.equal(m.store.ui.composer, "/fork ");
    await delay(20);
    assert.equal(hit.focused, 1);
    browser.document.found.delete(".composer textarea");
    m.store.preset("again");
    await delay(20);
    assert.equal(m.store.ui.composer, "again", "no composer on the page is fine");
  });
});

describe("formatting helpers", () => {
  test("number() is compact", () => {
    const out = [0, 999, 1000, 1234, 15_000, 1_500_000, 2_500_000_000].map(m.store.number);
    assert.deepEqual(out, ["0", "999", "1K", "1.2K", "15K", "1.5M", "2.5B"]);
  });

  test("json() is two-space pretty JSON", () => {
    assert.equal(m.store.json({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}');
  });

  test("shortPath() keeps the tail and marks the cut", () => {
    const { shortPath } = m.store;
    assert.equal(shortPath(), "");
    assert.equal(shortPath("/short"), "/short");
    assert.equal(shortPath("x".repeat(34)), "x".repeat(34), "exactly the limit is kept");
    const long = "/home/someone/a/very/long/path/to/some/project/dir";
    const cut = shortPath(long);
    assert.equal(cut.length, 34);
    assert.ok(cut.startsWith("…"));
    assert.ok(long.endsWith(cut.slice(1)));
    assert.equal(shortPath("abcdefghij", 5), "…ghij");
  });

  test("ago() counts in the largest whole unit", (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ["Date"], now });
    const ago = m.store.ago;
    assert.equal(ago(), "never");
    assert.equal(ago(0), "never");
    assert.equal(ago(now), "0s ago");
    assert.equal(ago(now + 5000), "0s ago", "a time in the future is not negative");
    assert.equal(ago(now - 5000), "5s ago");
    assert.equal(ago(now - 59_000), "59s ago");
    assert.equal(ago(now - 60_000), "1m ago");
    assert.equal(ago(now - 150_000), "3m ago");
    assert.equal(ago(now - 3_600_000), "1h ago");
    assert.equal(ago(now - 5 * 3_600_000), "5h ago");
    assert.equal(ago(now - 86_400_000), "1d ago");
    assert.equal(ago(now - 10 * 86_400_000), "10d ago");
  });

  // Between 3,570 and 3,599 seconds the minute count rounds up to 60, so it reads "60m ago" where
  // "1h ago" is meant: the hour boundary is tested on the unrounded seconds.
  test("ago() never says 60m", { todo: "rounds minutes up to 60 just below an hour" }, (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ["Date"], now });
    assert.equal(m.store.ago(now - 3_599_000), "1h ago");
  });

  test("icon() is the model's icon from the device, or the lab icon", async () => {
    await open([agentOf(1)], { info: { models: [modelInfo("fast", "fast.png")] } as never });
    assert.equal(m.store.icon("fast"), "/icons/fast.png");
    assert.equal(m.store.icon("unknown"), "/icons/lab.png");
    assert.equal(m.store.icon(), "/icons/lab.png");
  });
});

describe("interrupt", () => {
  test("it does nothing when nothing is selected or the agent is idle", async () => {
    await m.store.interrupt();
    await open();
    await m.store.interrupt();
    assert.equal(fetched("POST", /abort/).length, 0);
  });

  test("it aborts foreground work, leaves background jobs and tells the user", async () => {
    const o = await open();
    o.agent(snapshot({ run: { inputs: [1] } }));
    await m.store.interrupt();
    const [call] = fetched("POST", `${B}/agents/1/abort`);
    assert.deepEqual(call.body, { background: false });
    assert.equal(toast(), "Foreground work interrupted. Background jobs continue.");
    assert.equal(m.store.interrupting.value, false);
  });

  test("a second press while the first is in flight is ignored", async () => {
    const o = await open();
    o.agent(snapshot({ run: { inputs: [1] } }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    browser.fetch.handler = async () => (await gate, {});
    const first = m.store.interrupt();
    await until(() => m.store.interrupting.value, 1000, "interrupting");
    await m.store.interrupt();
    release();
    await first;
    assert.equal(fetched("POST", /abort/).length, 1);
  });

  test("a failed abort shows the error and no success toast, and frees the button", async () => {
    const o = await open();
    o.agent(snapshot({ run: { inputs: [1] } }));
    browser.fetch.handler = () => ({
      status: 503,
      body: { error: { code: "unavailable", message: "Dev is offline" } },
    });
    await m.store.interrupt();
    assert.equal(m.store.ui.error, "Dev is offline");
    assert.equal(toast(), "");
    assert.equal(m.store.interrupting.value, false);
  });
});

describe("panel layout", () => {
  test("on a wide screen the inspector and tree are columns that open and close", () => {
    const s = m.store;
    assert.equal(s.narrow.value, false);
    s.hideInspector();
    assert.equal(s.layout.inspector, false);
    assert.equal(s.inspectorExpanded.value, false);
    s.showInspector();
    assert.equal(s.layout.inspector, true);
    assert.equal(s.ui.tab, "session", "no tab named: it stays where it was");
    s.showInspector("tasks");
    assert.equal(s.ui.tab, "tasks");
    s.toggleInspector();
    assert.equal(s.layout.inspector, false);
    s.toggleInspector();
    assert.equal(s.layout.inspector, true);
    s.toggleTree();
    assert.equal(s.layout.tree, false);
    s.toggleTree();
    assert.equal(s.layout.tree, true);
    assert.equal(s.ui.drawer, false, "the drawer is a narrow-screen thing");
  });

  test("below 1100px the inspector opens over the chat and the tree becomes a drawer", () => {
    const s = m.store;
    browser.media.change(true);
    assert.equal(s.narrow.value, true);
    assert.equal(s.inspectorExpanded.value, false);
    s.showInspector("state");
    assert.equal(s.ui.inspectorOverlay, true);
    assert.equal(s.ui.tab, "state");
    assert.equal(s.inspectorExpanded.value, true);
    assert.equal(s.layout.inspector, true, "the column setting is not touched");
    s.hideInspector();
    assert.equal(s.ui.inspectorOverlay, false);
    s.toggleInspector();
    assert.equal(s.ui.inspectorOverlay, true);
    s.toggleInspector();
    assert.equal(s.ui.inspectorOverlay, false);
    s.layout.tree = false;
    s.toggleTree();
    assert.equal(s.ui.drawer, true);
    assert.equal(s.layout.tree, true, "opening the drawer shows the tree");
    s.toggleTree();
    assert.equal(s.ui.drawer, false);
  });

  test("crossing the breakpoint back and forth follows the media query", () => {
    browser.media.change(true);
    assert.equal(m.store.narrow.value, true);
    browser.media.change(false);
    assert.equal(m.store.narrow.value, false);
  });

  test("on Linux and Windows the panel keys are Alt+Shift+N and Alt+Shift+T", () => {
    const { panelKeys, panelHotkey } = m.store;
    assert.deepEqual(panelKeys, { tree: "Alt+Shift+N", inspector: "Alt+Shift+T" });
    const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
      panelHotkey({
        code,
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        ...mods,
      } as KeyboardEvent);
    assert.equal(key("KeyN"), "tree");
    assert.equal(key("KeyT"), "inspector");
    assert.equal(key("KeyX"), undefined);
    assert.equal(key("KeyN", { shiftKey: false }), undefined);
    assert.equal(key("KeyN", { altKey: false }), undefined);
    assert.equal(key("KeyN", { ctrlKey: true }), undefined);
    assert.equal(key("KeyN", { metaKey: true }), undefined);
    assert.equal(key("KeyN", { repeat: true }), undefined, "holding the key does not toggle again");
    assert.equal(key("KeyN", { isComposing: true }), undefined);
  });
});

describe("panel keys on a Mac", () => {
  test("Ctrl+N and Ctrl+T, because Cmd belongs to the browser", async () => {
    const mac = installBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    const mm = await loadClient();
    try {
      assert.deepEqual(mm.store.panelKeys, { tree: "Ctrl+N", inspector: "Ctrl+T" });
      const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
        mm.store.panelHotkey({
          code,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
          ...mods,
        } as KeyboardEvent);
      assert.equal(key("KeyN"), "tree");
      assert.equal(key("KeyT"), "inspector");
      assert.equal(key("KeyN", { metaKey: true }), undefined);
      assert.equal(key("KeyN", { shiftKey: true }), undefined);
      assert.equal(key("KeyN", { altKey: true }), undefined);
      assert.equal(key("KeyN", { ctrlKey: false }), undefined);
    } finally {
      await mm.unload();
      mac.restore();
    }
  });
});
