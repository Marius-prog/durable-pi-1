import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectEnvPath } from "../shared/paths.ts";
import { defaultModelId } from "../apps/proactive-dpi-be/src/model-catalog.ts";

const preload = resolve(import.meta.dirname, "config-preload.ts");
const probe = resolve(import.meta.dirname, "config-probe.ts");

type Config = {
  port: number;
  host: string;
  dev: boolean;
  model: string;
  thinking: string;
  incidentThreshold: number;
  suspiciousThreshold: number;
  windowMs: number;
  jevConcurrency: number;
  backlogMs: number;
  tts: string;
  announceOpen: boolean;
  voiceId: string;
  voiceModel: string;
  openedSpeech: string;
  readySpeech: string;
};

/** Loads config.ts in a fresh process with only these args and env vars (no keys, no project .env). */
function load(args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, probe, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 30_000,
  });
  if (result.status !== 0) return { ok: false as const, stderr: result.stderr };
  const out = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { config: Config; loadEnvCalls: string[] };
  return { ok: true as const, ...out };
}

function loaded(args: string[] = [], env: Record<string, string> = {}) {
  const r = load(args, env);
  assert.ok(r.ok, r.ok ? "" : r.stderr);
  return r;
}

test("defaults match the README flag table", () => {
  const { config } = loaded();
  assert.equal(config.port, 4790);
  assert.equal(config.host, "127.0.0.1", "loopback unless asked");
  assert.equal(config.dev, false);
  assert.equal(config.model, "anthropic/claude-sonnet-5.5");
  assert.equal(config.model, defaultModelId, "the flag default and the catalog default agree");
  assert.equal(config.thinking, "high");
  assert.equal(config.incidentThreshold, 3);
  assert.equal(config.suspiciousThreshold, 8);
  assert.equal(config.windowMs, 120_000);
  assert.equal(config.jevConcurrency, 6);
  assert.equal(config.backlogMs, 300_000);
  assert.equal(config.announceOpen, false);
});

test("defaults: the voice is Emma on eleven_v4_turbo, with the two spoken lines", () => {
  const { config } = loaded();
  assert.equal(config.voiceId, "56bWURjYFHyYyVf490Dp");
  assert.equal(config.voiceModel, "eleven_v4_turbo");
  assert.match(config.openedSpeech, /\{service\}/, "the opened line is a template");
  assert.equal(
    config.readySpeech,
    "Engineer, your Durable Agent Red Team found a production issue, and found the fix. It's waiting on your review.",
  );
});

test("defaults: --tts is host on macOS and browser everywhere else", () => {
  const expected = process.platform === "darwin" ? "host" : "browser";
  assert.equal(loaded().config.tts, expected);
});

test("every flag overrides its default and parses as the right type", () => {
  const { config } = loaded([
    "--port", "5001",
    "--host", "0.0.0.0",
    "--dev",
    "--model", "openai/gpt-6.1-sol",
    "--thinking", "low",
    "--incident-threshold", "5",
    "--suspicious-threshold", "2",
    "--window", "30",
    "--jev-concurrency", "2",
    "--backlog", "10",
    "--tts", "both",
    "--announce-open",
  ]);
  assert.deepEqual(
    [config.port, config.host, config.dev, config.model, config.thinking],
    [5001, "0.0.0.0", true, "openai/gpt-6.1-sol", "low"],
  );
  assert.deepEqual(
    [config.incidentThreshold, config.suspiciousThreshold, config.windowMs, config.jevConcurrency, config.backlogMs],
    [5, 2, 30_000, 2, 10_000],
    "--window and --backlog are given in seconds and stored in milliseconds",
  );
  assert.equal(config.tts, "both");
  assert.equal(config.announceOpen, true);
});

test("--tts accepts host, browser, both and off", () => {
  for (const mode of ["host", "browser", "both", "off"]) assert.equal(loaded(["--tts", mode]).config.tts, mode);
});

test("--tts rejects anything else", () => {
  const r = load(["--tts", "loud"]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.stderr, /--tts is host, browser, both, or off/);
});

test("a flag with no value, or whose value is another flag, is an error", () => {
  for (const args of [["--port"], ["--port", "--dev"], ["--model", "--thinking", "low"]]) {
    const r = load(args);
    assert.equal(r.ok, false, args.join(" "));
    assert.match(r.ok ? "" : r.stderr, new RegExp(`${args[0]} needs a value`));
  }
});

test("boolean flags need no value and do not swallow the next flag", () => {
  const { config } = loaded(["--dev", "--announce-open", "--port", "4800"]);
  assert.equal(config.dev, true);
  assert.equal(config.announceOpen, true);
  assert.equal(config.port, 4800);
});

test("ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, DPI_OPENED_SPEECH and DPI_READY_SPEECH override the voice", () => {
  const { config } = loaded([], {
    ELEVENLABS_VOICE_ID: "voice-123",
    ELEVENLABS_MODEL: "eleven_test",
    DPI_OPENED_SPEECH: "Heads up in {service}.",
    DPI_READY_SPEECH: "Ready to deploy.",
  });
  assert.equal(config.voiceId, "voice-123");
  assert.equal(config.voiceModel, "eleven_test");
  assert.equal(config.openedSpeech, "Heads up in {service}.");
  assert.equal(config.readySpeech, "Ready to deploy.");
});

test("an empty ELEVENLABS_VOICE_ID is kept as given (only an unset variable falls back)", () => {
  assert.equal(loaded([], { ELEVENLABS_VOICE_ID: "" }).config.voiceId, "");
});

test("the project .env is loaded from the project root, and only when it exists", () => {
  const { loadEnvCalls } = loaded();
  if (existsSync(projectEnvPath)) assert.deepEqual(loadEnvCalls, [projectEnvPath]);
  else assert.deepEqual(loadEnvCalls, []);
  assert.equal(projectEnvPath, resolve(import.meta.dirname, "../../../.env"));
});

// config.ts does no range checks: `--incident-threshold three` becomes NaN, `logIds.length < NaN` is always false,
// and the watcher would then open an incident on the very first non-normal verdict. The tts flag is validated;
// the numeric flags are not. Un-todo this when they are.
test.todo("a non-numeric or non-positive numeric flag is rejected at startup");
