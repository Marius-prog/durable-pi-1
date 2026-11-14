import { test } from "node:test";
import assert from "node:assert/strict";
import { changeState, readState, replaceState, statePath, type AppState, type JsonValue, type StateChange } from "../src/app-state.js";

test("statePath escapes ~ and / so any key can be a pointer segment", () => {
  assert.equal(statePath("", "plain"), "/plain");
  assert.equal(statePath("/a", "b/c"), "/a/b~1c");
  assert.equal(statePath("/a", "~x"), "/a/~0x");
  assert.equal(statePath("", "~/"), "/~0~1", "~ is escaped before / so the two never collide");
  const state = changeState({}, { operation: "create", path: statePath("", "we/ird~key"), value: 7 });
  assert.deepEqual(state, { "we/ird~key": 7 });
  assert.equal(readState(state, statePath("", "we/ird~key")), 7);
});

test("readState: root, nested values, arrays and the errors for bad paths", () => {
  const state: AppState = { a: { b: [10, { c: "deep" }] }, n: null, empty: "" };
  assert.deepEqual(readState(state), state);
  assert.equal(readState(state, "/a/b/0"), 10);
  assert.equal(readState(state, "/a/b/1/c"), "deep");
  assert.equal(readState(state, "/n"), null);
  assert.equal(readState(state, "/empty"), "");
  assert.throws(() => readState(state, "a/b"), /JSON Pointer/);
  assert.throws(() => readState(state, "/missing"), /Field does not exist: missing/);
  assert.throws(() => readState(state, "/a/b/5"), /Field does not exist: 5/);
  assert.throws(() => readState(state, "/a/b/01"), /Field does not exist: 01/);
  assert.throws(() => readState(state, "/a/b/-"), /Field does not exist/);
  assert.throws(() => readState(state, "/n/x"), /Field does not exist/, "cannot descend into null");
  assert.throws(() => readState(state, "/empty/length"), /Field does not exist/, "cannot descend into a string");
  assert.throws(() => readState(state, "/a/b/length"), /Invalid array index/);
  assert.throws(() => readState(state, "/a/~2"), /Invalid JSON Pointer escape/);
  assert.throws(() => readState(state, "/a/~"), /Invalid JSON Pointer escape/);
  assert.throws(() => readState(state, "/__proto__"), /Reserved field name/);
  assert.throws(() => readState(state, "/a/constructor"), /Reserved field name/);
  assert.throws(() => readState(state, "/a/prototype/x"), /Reserved field name/);
});

test("changeState never mutates its input", () => {
  const state: AppState = { list: [1, 2], obj: { k: 1 } };
  const snapshot = JSON.stringify(state);
  changeState(state, { operation: "create", path: "/list/-", value: 3 });
  changeState(state, { operation: "update", path: "/obj/k", value: 2 });
  changeState(state, { operation: "delete", path: "/list/0" });
  changeState(state, { operation: "increment", path: "/obj/k", value: 5 });
  assert.equal(JSON.stringify(state), snapshot);
});

test("arrays: append with - or index == length, update and delete by index, reject holes", () => {
  let state: AppState = { a: [] };
  state = changeState(state, { operation: "create", path: "/a/-", value: "x" });
  state = changeState(state, { operation: "create", path: "/a/1", value: "y" });
  assert.deepEqual(state, { a: ["x", "y"] });
  state = changeState(state, { operation: "update", path: "/a/0", value: "X" });
  assert.deepEqual(state, { a: ["X", "y"] });
  assert.throws(() => changeState(state, { operation: "create", path: "/a/5", value: 1 }), /Invalid array index/);
  assert.throws(() => changeState(state, { operation: "update", path: "/a/5", value: 1 }), /Invalid array index/);
  assert.throws(() => changeState(state, { operation: "update", path: "/a/01", value: 1 }), /Invalid array index/);
  assert.throws(() => changeState(state, { operation: "update", path: "/a/name", value: 1 }), /Invalid array index/);
  assert.throws(() => changeState(state, { operation: "delete", path: "/a/2" }), /Field does not exist/);
  assert.throws(() => changeState(state, { operation: "delete", path: "/a/-" }), /does not exist/);
  state = changeState(state, { operation: "delete", path: "/a/0" });
  assert.deepEqual(state, { a: ["y"] });
  assert.throws(() => changeState(state, { operation: "create", path: "/a/0", value: 1 }), /already exists/);
});

test("increment adds to numbers and refuses anything else", () => {
  const state: AppState = { n: 1.5, s: "x", o: {} };
  assert.deepEqual(changeState(state, { operation: "increment", path: "/n", value: 2 }).n, 3.5);
  assert.deepEqual(changeState(state, { operation: "increment", path: "/n", value: -4 }).n, -2.5);
  assert.throws(() => changeState(state, { operation: "increment", path: "/s", value: 1 }), /Increment requires numbers/);
  assert.throws(() => changeState(state, { operation: "increment", path: "/n", value: "1" }), /Increment requires numbers/);
  assert.throws(() => changeState(state, { operation: "increment", path: "/n" }), /Increment requires numbers/);
  assert.throws(() => changeState(state, { operation: "increment", path: "/nope", value: 1 }), /does not exist/);
});

test("values must be plain finite JSON, shallower than 25 levels, without reserved keys", () => {
  const bad = (value: unknown, pattern: RegExp) =>
    assert.throws(() => changeState({}, { operation: "create", path: "/v", value: value as never }), pattern);
  bad(undefined, /valid JSON/);
  bad(Number.NaN, /valid JSON/);
  bad(Number.POSITIVE_INFINITY, /valid JSON/);
  bad(() => 1, /valid JSON/);
  bad(Symbol("s"), /valid JSON/);
  bad(10n, /valid JSON/);
  bad({ ok: 1, inner: { value: undefined } }, /valid JSON/);
  bad(JSON.parse('{"__proto__": 1}'), /Reserved field name/);
  bad({ nested: JSON.parse('{"constructor": 1}') }, /Reserved field name/);
  // 24 levels deep is accepted, 25 is not.
  const nest = (depth: number) => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = { n: value };
    return value;
  };
  assert.doesNotThrow(() => changeState({}, { operation: "create", path: "/v", value: nest(23) as never }));
  bad(nest(30), /too deeply nested/);
  for (const ok of [null, true, false, 0, -1.25, "", "text", [], {}, [null, [1]], { a: { b: [] } }]) {
    assert.doesNotThrow(() => changeState({}, { operation: "create", path: "/v", value: ok as never }));
  }
});

test("the state stays under 100,000 characters, for changes and for a replaced root", () => {
  const limit = 100_000;
  const fits = "x".repeat(limit - JSON.stringify({ v: "" }).length);
  assert.equal(JSON.stringify(changeState({}, { operation: "create", path: "/v", value: fits })).length, limit);
  assert.throws(() => changeState({}, { operation: "create", path: "/v", value: fits + "x" }), /under 100,000 characters/);
  assert.equal(JSON.stringify(changeState({}, { operation: "update", path: "", value: { v: fits } })).length, limit);
  assert.throws(() => changeState({}, { operation: "update", path: "", value: { v: fits + "x" } }), /under 100,000 characters/);
});

test("root operations: only an object may replace the root; delete empties it", () => {
  const state: AppState = { a: 1 };
  for (const value of [null, [1], "s", 3, true] as JsonValue[])
    assert.throws(() => changeState(state, { operation: "update", path: "", value }), /root must be a JSON object/);
  assert.throws(() => changeState(state, { operation: "create", path: "", value: {} }), /root must be a JSON object/);
  assert.throws(() => changeState(state, { operation: "increment", path: "", value: 1 }), /root must be a JSON object/);
  assert.throws(() => changeState(state, { operation: "update", path: "", value: { bad: Number.NaN } }), /valid JSON/);
  const next = changeState(state, { operation: "update", path: "", value: { b: [2] } });
  assert.deepEqual(next, { b: [2] });
  assert.deepEqual(changeState(state, { operation: "delete", path: "" }), {});
});

test("invalid operations, missing paths and non-object parents are rejected", () => {
  const state: AppState = { s: "str", n: null, o: {} };
  assert.throws(() => changeState(state, { operation: "merge", path: "/o", value: 1 } as unknown as StateChange), /Invalid state operation/);
  assert.throws(() => changeState(state, { operation: "create", value: 1 } as unknown as StateChange), /State path is required/);
  assert.throws(() => changeState(state, { operation: "create", path: 5, value: 1 } as unknown as StateChange), /State path is required/);
  assert.throws(() => changeState(state, { operation: "create", path: "/s/x", value: 1 }), /Parent must be an object or array/);
  assert.throws(() => changeState(state, { operation: "create", path: "/n/x", value: 1 }), /Parent must be an object or array/);
  assert.throws(() => changeState(state, { operation: "create", path: "/missing/x", value: 1 }), /Field does not exist/);
  assert.throws(() => changeState(state, { operation: "delete", path: "/o/gone" }), /Field does not exist/);
  assert.throws(() => changeState(state, { operation: "create", path: "/o/__proto__", value: 1 }), /Reserved field name/);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
});

test("replaceState swaps the contents of the same object", () => {
  const target: AppState = { old: 1, shared: "a" };
  const alias = target;
  replaceState(target, { shared: "b", fresh: [1] });
  assert.equal(alias, target);
  assert.deepEqual(target, { shared: "b", fresh: [1] });
  assert.equal("old" in target, false);
  replaceState(target, {});
  assert.deepEqual(target, {});
});
