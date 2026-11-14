import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { demoDir } from "../shared/paths.ts";
import { curatedModels, defaultModelId } from "../apps/proactive-dpi-be/src/model-catalog.ts";

test("every model has an OpenRouter-style id, a display name, a tier and an icon", () => {
  assert.ok(curatedModels.length > 0);
  for (const m of curatedModels) {
    assert.match(m.id, /^[a-z0-9.-]+\/[a-z0-9.~_-]+$/i, m.id);
    assert.ok(m.name.trim().length > 0, m.id);
    assert.match(m.tier, /^(S\+|S|A|B)$/, m.id);
    assert.match(m.icon, /\.png$/, m.id);
  }
});

test("ids and names are unique", () => {
  const ids = curatedModels.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  const names = curatedModels.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
});

test("every icon the list names ships with the UI", () => {
  for (const m of curatedModels)
    assert.ok(existsSync(join(demoDir, "apps/proactive-dpi-fe/public/icons", m.icon)), `${m.id} -> ${m.icon}`);
});

test("the list is ordered best tier first", () => {
  const rank = { "S+": 0, S: 1, A: 2, B: 3 } as const;
  const ranks = curatedModels.map((m) => rank[m.tier]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("the default model is in the list", () => {
  assert.ok(curatedModels.some((m) => m.id === defaultModelId));
  assert.equal(defaultModelId, "anthropic/claude-sonnet-5.5");
});
