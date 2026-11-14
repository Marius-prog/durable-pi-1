// The openrouter provider branch of the Store, with no key and no network. Without OPENROUTER_API_KEY the device
// lists no models and never calls out, so model routing and validation can be tested offline. Nothing here sends a
// model request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Store } from "../src/store.js";
import { curatedModels, defaultModelId } from "../src/model-catalog.js";
import { tempStore } from "./helpers.js";

const KEYS = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const openRouterStore = async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, provider: "openrouter" });
  return { t, store };
};

test("model catalog: ids are unique, every entry is complete and the default is one of them", () => {
  assert.equal(new Set(curatedModels.map((m) => m.id)).size, curatedModels.length);
  for (const m of curatedModels) {
    assert.match(m.id, /^[a-z0-9.-]+\/[a-z0-9._-]+$/i, m.id);
    assert.ok(m.name && m.icon.endsWith(".png"), m.id);
    assert.ok(["S+", "S", "A", "B"].includes(m.tier), `${m.id} tier ${m.tier}`);
  }
  assert.ok(curatedModels.some((m) => m.id === defaultModelId));
});

test("without a key the device lists no models and defaults to the catalog default", async () => {
  const { t, store } = await openRouterStore();
  try {
    assert.deepEqual(store.modelList, []);
    assert.equal(store.deviceInfo().defaultModel, defaultModelId);
    assert.deepEqual(store.deviceInfo().models, []);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("routedModel sends everything to openrouter and falls back to the default for unknown models", async () => {
  const { t, store } = await openRouterStore();
  try {
    const [first, second] = curatedModels;
    assert.deepEqual(store.routedModel({ provider: "openrouter", modelId: first.id }), { provider: "openrouter", modelId: first.id });
    // A model stored by a device on another provider arrives as vendor + id and is mapped onto openrouter's id.
    const [vendor, id] = second.id.split("/");
    assert.deepEqual(store.routedModel({ provider: vendor, modelId: id }), { provider: "openrouter", modelId: second.id });
    // Unknown, missing or from the faux provider: the default.
    for (const model of [{ provider: "openrouter", modelId: "nope/nope" }, { provider: "faux", modelId: "echo" }, undefined])
      assert.deepEqual(store.routedModel(model as never), { provider: "openrouter", modelId: defaultModelId });
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("validateModel accepts a curated openrouter model and refuses faux or unknown ones", async () => {
  const { t, store } = await openRouterStore();
  try {
    assert.deepEqual(store.validateModel({ provider: "openrouter", modelId: defaultModelId }), { provider: "openrouter", modelId: defaultModelId });
    for (const model of [
      { provider: "faux", modelId: "echo" },
      { provider: "openrouter", modelId: "not/curated" },
      { provider: "anthropic", modelId: defaultModelId },
      { provider: "openrouter" },
      null,
      "string",
    ])
      assert.throws(() => store.validateModel(model), /model must be|Unknown model/, JSON.stringify(model));
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a session created on the openrouter device keeps its model and survives a restart without calling out", async () => {
  const { t, store } = await openRouterStore();
  let reopened: Store | undefined;
  try {
    const session = await store.create({ name: "Routed", cwd: t.work, model: { provider: "openrouter", modelId: curatedModels[1].id } });
    assert.equal(session.model, curatedModels[1].id);
    await store.close();
    reopened = await Store.open({ ...t.options, provider: "openrouter" });
    assert.equal(reopened.list()[0].model, curatedModels[1].id);
    assert.equal(reopened.list()[0].provider, "openrouter");
  } finally {
    await reopened?.close();
    await store.close().catch(() => {});
    await t.cleanup();
  }
});

test("a session stored by a faux device is routed to the default model when the device runs openrouter", async () => {
  const t = await tempStore();
  const faux = await Store.open({ ...t.options, provider: "faux" });
  let routed: Store | undefined;
  try {
    const session = await faux.create({ name: "Was faux", cwd: t.work, model: { provider: "faux", modelId: "echo" } });
    await faux.close();
    routed = await Store.open({ ...t.options, provider: "openrouter" });
    const row = routed.list().find((r) => r.id === session.id)!;
    assert.equal(row.provider, "openrouter");
    assert.equal(row.model, defaultModelId);
    const { c } = await routed.resolveAgent(session.id, "main");
    assert.equal((await c.agent(ctx)).model?.modelId, defaultModelId);
  } finally {
    await routed?.close();
    await faux.close().catch(() => {});
    await t.cleanup();
  }
});

test("the openrouter device keeps its data under the data dir it was given", async () => {
  const { t, store } = await openRouterStore();
  try {
    assert.equal(store.catalogPath, join(t.options.dataDir, "catalog.sqlite"));
    assert.equal(store.sharedStatePath, join(t.options.dataDir, "app-state.sqlite"));
    assert.equal(store.sessionsDir, join(t.options.dataDir, "sessions"));
    assert.equal(store.archiveDir, join(t.options.dataDir, "archive"));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
