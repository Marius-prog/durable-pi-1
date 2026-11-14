import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { toolSignature, type Token } from "../apps/dpi-playground-fe/src/client/signature.js";
import { newId } from "../apps/dpi-playground-fe/src/client/ids.js";

const code = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const sig = (parameters: unknown, name = "tool") => code(toolSignature(name, parameters));
const wrap = (args: string, name = "tool") =>
  `function ${name}(args: ${args}): Promise<ToolResult>;`;

describe("toolSignature: the declaration around the schema", () => {
  test("an empty object is {}", () => {
    assert.equal(sig({ type: "object", properties: {} }), wrap("{}"));
    assert.equal(sig({ type: "object" }), wrap("{}"));
  });

  test("the name is used as given", () => {
    assert.equal(sig({ type: "object" }, "read_file"), wrap("{}", "read_file"));
  });

  test("every token has a kind that names what it is", () => {
    const tokens = toolSignature("bash", {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "What to run" },
        timeout: { type: "number" },
        mode: { enum: ["fast", 2] },
      },
    });
    const kind = (text: string) => tokens.filter((t) => t.text === text).map((t) => t.kind);
    assert.deepEqual(kind("function"), ["keyword"]);
    assert.deepEqual(kind("bash"), ["function"]);
    assert.deepEqual(kind("command"), ["property"]);
    assert.ok(kind("string").every((k) => k === "type"));
    assert.deepEqual(kind("Promise"), ["type"]);
    assert.deepEqual(kind("ToolResult"), ["type"]);
    assert.deepEqual(kind('"fast"'), ["string"]);
    assert.deepEqual(kind("2"), ["number"]);
    assert.ok(tokens.some((t) => t.kind === "comment" && t.text.includes("What to run")));
    assert.ok(tokens.filter((t) => t.kind === "punct").some((t) => t.text === "{"));
  });
});

describe("toolSignature: properties", () => {
  test("required properties use ':' and optional ones use '?:'", () => {
    assert.equal(
      sig({
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
          force: { type: "boolean" },
        },
      }),
      wrap("{\n  path: string;\n  limit?: number;\n  force?: boolean;\n}"),
    );
  });

  test("a key that is not an identifier is quoted", () => {
    const out = sig({
      type: "object",
      properties: {
        "content-type": { type: "string" },
        "9lives": { type: "string" },
        ok_1$: { type: "string" },
      },
    });
    assert.ok(out.includes('"content-type"?: string;'));
    assert.ok(out.includes('"9lives"?: string;'));
    assert.ok(out.includes("ok_1$?: string;"));
  });

  test("a description, limits and a default become a doc comment above the property", () => {
    const out = sig({
      type: "object",
      properties: {
        n: { type: "number", description: "How many", minimum: 1, maximum: 10, default: 5 },
        s: { type: "string", default: "hi" },
        z: { type: "number", minimum: 0 },
        d: { type: "number", default: 0 },
        plain: { type: "string" },
      },
    });
    assert.ok(
      out.includes("  /** How many @minimum 1 @maximum 10 @default 5 */\n  n?: number;"),
      out,
    );
    assert.ok(out.includes('  /** @default "hi" */\n  s?: string;'), out);
    assert.ok(out.includes("  /** @minimum 0 */\n  z?: number;"), "a minimum of 0 still counts");
    assert.ok(out.includes("  /** @default 0 */\n  d?: number;"), "a default of 0 still counts");
    assert.ok(out.includes("\n  plain?: string;"));
    assert.ok(!out.includes("*/\n  plain"), "a property with nothing to say gets no comment");
  });

  test("nested objects indent by two spaces per level", () => {
    assert.equal(
      sig({
        type: "object",
        required: ["a"],
        properties: {
          a: {
            type: "object",
            required: ["b"],
            properties: { b: { type: "object", properties: { c: { type: "string" } } } },
          },
        },
      }),
      wrap("{\n  a: {\n    b: {\n      c?: string;\n    };\n  };\n}"),
    );
  });

  test("a doc comment inside a nested object is indented with it", () => {
    const out = sig({
      type: "object",
      properties: {
        o: { type: "object", properties: { x: { type: "string", description: "inner" } } },
      },
    });
    assert.ok(out.includes("    /** inner */\n    x?: string;"), out);
  });
});

describe("toolSignature: types", () => {
  const ts = (schema: unknown) => {
    const out = sig({ type: "object", required: ["v"], properties: { v: schema } });
    return out
      .replace(/^function tool\(args: \{\n {2}v: /, "")
      .replace(/;\n\}\): Promise<ToolResult>;$/, "");
  };

  test("primitives", () => {
    assert.equal(ts({ type: "string" }), "string");
    assert.equal(ts({ type: "boolean" }), "boolean");
    assert.equal(ts({ type: "null" }), "null");
    assert.equal(ts({ type: "number" }), "number");
    assert.equal(ts({ type: "integer" }), "number");
  });

  test("anything it cannot read is unknown", () => {
    assert.equal(ts({}), "unknown");
    assert.equal(ts({ type: "mystery" }), "unknown");
    assert.equal(ts("string"), "unknown");
    assert.equal(ts(true), "unknown", "a boolean schema is valid JSON Schema but carries no type");
  });

  // type() guards against a null schema, but object() reads `.description` off each property first,
  // so one null property makes the whole declaration throw instead of printing `unknown`.
  test(
    "a null property schema is unknown, not a crash",
    { todo: "docComment() does not guard null or undefined" },
    () => {
      assert.equal(ts(null), "unknown");
      assert.equal(ts(undefined), "unknown");
    },
  );

  test("the top level can be unknown too", () => {
    assert.equal(sig(undefined), wrap("unknown"));
    assert.equal(sig({ type: "string" }), wrap("string"));
  });

  test("enums and consts become literal unions", () => {
    assert.equal(ts({ enum: ["a", "b"] }), '"a" | "b"');
    assert.equal(ts({ enum: [1, 2.5, true, null] }), "1 | 2.5 | true | null");
    assert.equal(ts({ const: "x" }), '"x"');
    assert.equal(ts({ const: 0 }), "0");
    assert.equal(ts({ const: false }), "false");
    assert.equal(ts({ const: null }), "null");
  });

  test("a string with quotes in an enum is escaped as JSON", () => {
    assert.equal(ts({ enum: ['say "hi"'] }), '"say \\"hi\\""');
  });

  test("anyOf and oneOf join with |, and anyOf wins when both are present", () => {
    assert.equal(ts({ anyOf: [{ type: "string" }, { type: "number" }] }), "string | number");
    assert.equal(ts({ oneOf: [{ type: "boolean" }, { type: "null" }] }), "boolean | null");
    assert.equal(ts({ anyOf: [{ type: "string" }], oneOf: [{ type: "number" }] }), "string");
  });

  test("a type list becomes a union", () => {
    assert.equal(ts({ type: ["string", "null"] }), "string | null");
    assert.equal(ts({ type: ["integer", "boolean"] }), "number | boolean");
  });

  test("arrays", () => {
    assert.equal(ts({ type: "array", items: { type: "string" } }), "string[]");
    assert.equal(ts({ type: "array" }), "unknown[]");
    assert.equal(
      ts({ type: "array", items: { type: "array", items: { type: "number" } } }),
      "number[][]",
    );
  });

  test("an array of a union is parenthesised so [] binds to all of it", () => {
    assert.equal(
      ts({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
      "(string | number)[]",
    );
    assert.equal(
      ts({ type: "array", items: { oneOf: [{ type: "string" }, { type: "null" }] } }),
      "(string | null)[]",
    );
    assert.equal(ts({ type: "array", items: { enum: ["a", "b"] } }), '("a" | "b")[]');
  });

  test("an array of objects spreads the object", () => {
    assert.equal(
      ts({
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      }),
      "{\n    id: string;\n  }[]",
    );
  });

  test("an object with only additionalProperties is a Record", () => {
    assert.equal(
      ts({ type: "object", additionalProperties: { type: "number" } }),
      "Record<string, number>",
    );
    assert.equal(
      ts({ type: "object", additionalProperties: { type: "array", items: { type: "string" } } }),
      "Record<string, string[]>",
    );
  });

  test("an object with additionalProperties: true or false and no properties is {}", () => {
    assert.equal(ts({ type: "object", additionalProperties: true }), "{}");
    assert.equal(ts({ type: "object", additionalProperties: false }), "{}");
  });

  test("properties win over additionalProperties", () => {
    assert.equal(
      ts({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "number" },
      }),
      "{\n    a?: string;\n  }",
    );
  });
});

describe("newId", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "crypto", real);
  });
  const withCrypto = (value: unknown) =>
    Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });

  test("is a v4 UUID when crypto is there, and different every time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    assert.equal(ids.size, 50);
    for (const id of ids)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("falls back to a timestamp and random suffix without crypto.randomUUID", () => {
    withCrypto({});
    const a = newId();
    const b = newId();
    assert.match(a, /^\d{13}-[a-z0-9]+$/);
    assert.notEqual(a, b);
  });

  test("falls back when there is no crypto at all", () => {
    withCrypto(undefined);
    assert.match(newId(), /^\d{13}-[a-z0-9]+$/);
  });
});
