import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { c, editorTheme, markdownTheme, selectTheme } from "../src/theme.ts";

const esc = (s: string) => s.replaceAll("\x1b", "<ESC>");

test("each palette color wraps text in a 24-bit foreground code and resets only the foreground", () => {
  const palette: Record<string, string> = {
    accent: "#ff8997",
    muted: "#a08a74",
    secondary: "#c9a87c",
    text: "#f2eeee",
    ok: "#6fcf97",
    warn: "#f2c66d",
    err: "#ff6b6b",
    user: "#8ec5ff",
  };
  for (const [name, hex] of Object.entries(palette)) {
    const n = parseInt(hex.slice(1), 16);
    const expected = `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
    const out = (c as unknown as Record<string, (s: string) => string>)[name]("hi");
    assert.equal(out, `${expected}hi\x1b[39m`, `${name}: ${esc(out)}`);
  }
});

test("known colors keep their exact RGB triplets", () => {
  assert.equal(c.accent("x"), "\x1b[38;2;255;137;151mx\x1b[39m");
  assert.equal(c.err("x"), "\x1b[38;2;255;107;107mx\x1b[39m");
  assert.equal(c.ok("x"), "\x1b[38;2;111;207;151mx\x1b[39m");
});

test("text attributes use their own on and off codes", () => {
  assert.equal(c.bold("x"), "\x1b[1mx\x1b[22m");
  assert.equal(c.dim("x"), "\x1b[2mx\x1b[22m");
  assert.equal(c.italic("x"), "\x1b[3mx\x1b[23m");
  assert.equal(c.underline("x"), "\x1b[4mx\x1b[24m");
  assert.equal(c.strike("x"), "\x1b[9mx\x1b[29m");
  assert.equal(c.userBg("x"), "\x1b[48;2;43;32;33mx\x1b[49m");
});

test("styling adds no visible width and keeps the text, including the empty string and wide characters", () => {
  for (const text of ["", "plain", "漢字🙂", "two\nlines"]) {
    for (const [name, style] of Object.entries(c)) {
      const out = style(text);
      assert.ok(out.includes(text), name);
      if (!text.includes("\n")) assert.equal(visibleWidth(out), visibleWidth(text), `${name} width of ${JSON.stringify(text)}`);
    }
  }
});

test("styles nest: an inner reset of one attribute does not end the others", () => {
  const out = c.bold(c.accent("x"));
  assert.equal(out, "\x1b[1m\x1b[38;2;255;137;151mx\x1b[39m\x1b[22m");
});

test("the markdown theme styles every element and keeps the text", () => {
  const keys = ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"] as const;
  for (const key of keys) {
    const out = markdownTheme[key]("sample");
    assert.equal(typeof out, "string", key);
    assert.ok(out.includes("sample"), key);
  }
  assert.equal(markdownTheme.heading("h"), c.bold(c.accent("h")), "headings are bold accent");
  assert.equal(markdownTheme.link("l"), c.user("l"));
  assert.equal(markdownTheme.code("k"), c.secondary("k"));
  assert.equal(markdownTheme.bold("b"), c.bold("b"));
  assert.equal(markdownTheme.strikethrough("s"), c.strike("s"));
});

test("the select theme highlights the selection in bold accent and mutes the rest", () => {
  assert.equal(selectTheme.selectedPrefix("→"), c.accent("→"));
  assert.equal(selectTheme.selectedText("row"), c.bold(c.accent("row")));
  for (const key of ["description", "scrollInfo", "noMatch"] as const) assert.equal(selectTheme[key]("t"), c.muted("t"), key);
});

test("the editor theme draws a muted border and uses the select theme for completions", () => {
  assert.equal(editorTheme.borderColor("─"), c.muted("─"));
  assert.equal(editorTheme.selectList, selectTheme);
});
