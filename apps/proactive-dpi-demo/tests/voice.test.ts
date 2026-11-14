import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delay, tempDir, until, withEnv } from "./helpers.ts";
import { Voice, type Speech } from "../apps/proactive-dpi-be/src/voice.ts";

let t: ReturnType<typeof tempDir>;
let ttsDir: string;
let restoreEnv: () => void;
let fetchMock: ReturnType<typeof mock.method>;
let calls: { url: string; init: RequestInit }[];
let behave: (n: number) => Response | Promise<Response>;
let log: ReturnType<typeof mock.method>;
let errors: ReturnType<typeof mock.method>;

beforeEach(() => {
  t = tempDir();
  ttsDir = join(t.root, "tts");
  restoreEnv = withEnv({ ELEVENLABS_API_KEY: "xi-test-key" });
  calls = [];
  behave = () => new Response(Buffer.from("MP3-BYTES"), { status: 200 });
  fetchMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return behave(calls.length);
  });
  log = mock.method(console, "log", () => {});
  errors = mock.method(console, "error", () => {});
});
afterEach(() => {
  fetchMock.mock.restore();
  log.mock.restore();
  errors.mock.restore();
  restoreEnv();
  t.cleanup();
});

const hashOf = (voiceId: string, model: string, text: string) =>
  createHash("sha1").update(`${voiceId}|${model}|${text}`).digest("hex").slice(0, 16);

function listen(voice: Voice) {
  const speeches: Speech[] = [];
  voice.on("speech", (s: Speech) => speeches.push(s));
  return speeches;
}

test("browser mode: synthesizes once, caches the mp3 on disk, and tells the browser where to fetch it", async () => {
  const voice = new Voice("browser", ttsDir, "voice-1", "eleven_x");
  const speeches = listen(voice);
  voice.say("Engineer, deploy waiting.");
  await until(() => speeches.length === 1);

  const hash = hashOf("voice-1", "eleven_x", "Engineer, deploy waiting.");
  assert.deepEqual(speeches[0], { text: "Engineer, deploy waiting.", url: `/api/tts/${hash}.mp3`, at: speeches[0].at, browser: true });
  assert.ok(Math.abs(speeches[0].at - Date.now()) < 5000);
  assert.equal(readFileSync(join(ttsDir, `${hash}.mp3`), "utf8"), "MP3-BYTES");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=mp3_44100_128");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "xi-api-key": "xi-test-key", "Content-Type": "application/json", Accept: "audio/mpeg" });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    text: "Engineer, deploy waiting.",
    model_id: "eleven_x",
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0 },
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "a stuck request times out");
});

test("saying the same line again reuses the audio without another API call", async () => {
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("same line");
  voice.say("same line");
  await until(() => speeches.length === 2);
  assert.equal(calls.length, 1);
  assert.equal(speeches[0].url, speeches[1].url);
});

test("a new Voice finds mp3s a previous run left on disk and never calls the API", async () => {
  const hash = hashOf("v", "m", "from disk");
  mkdirSync(ttsDir, { recursive: true });
  writeFileSync(join(ttsDir, `${hash}.mp3`), "OLD");
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("from disk");
  await until(() => speeches.length === 1);
  assert.equal(calls.length, 0);
  assert.equal(speeches[0].url, `/api/tts/${hash}.mp3`);
  assert.equal(readFileSync(join(ttsDir, `${hash}.mp3`), "utf8"), "OLD");
});

test("the cache key includes the voice and the model", async () => {
  const lines = [new Voice("browser", ttsDir, "v1", "m"), new Voice("browser", ttsDir, "v2", "m"), new Voice("browser", ttsDir, "v1", "m2")];
  const urls: string[] = [];
  for (const voice of lines) {
    const speeches = listen(voice);
    voice.say("same text");
    await until(() => speeches.length === 1);
    urls.push(speeches[0].url!);
  }
  assert.equal(new Set(urls).size, 3);
  assert.equal(calls.length, 3);
});

test("prepare: synthesizes ahead of time so say plays without another call", async () => {
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.prepare("the ready line");
  await until(() => existsSync(join(ttsDir, `${hashOf("v", "m", "the ready line")}.mp3`)));
  voice.say("the ready line");
  await until(() => speeches.length === 1);
  assert.equal(calls.length, 1);
});

test("prepare and say racing on the same text share one request", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  behave = async () => {
    await slow;
    return new Response("X");
  };
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.prepare("race");
  voice.say("race");
  await delay(30);
  release();
  await until(() => speeches.length === 1);
  assert.equal(calls.length, 1);
});

test("without an API key the line is only emitted as a toast: no request, no file", async () => {
  restoreEnv();
  restoreEnv = withEnv({ ELEVENLABS_API_KEY: undefined });
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.prepare("quiet");
  voice.say("quiet");
  assert.equal(speeches.length, 1, "emitted synchronously");
  assert.deepEqual({ ...speeches[0], at: 0 }, { text: "quiet", url: null, at: 0, browser: false });
  assert.equal(calls.length, 0);
  assert.equal(existsSync(ttsDir), false);
});

test("mode off behaves like having no key, even with a key set", () => {
  const voice = new Voice("off", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("off");
  assert.equal(speeches.length, 1);
  assert.equal(speeches[0].url, null);
  assert.equal(speeches[0].browser, false);
  assert.equal(calls.length, 0);
});

test("say always prints the line to the terminal log", () => {
  const voice = new Voice("off", ttsDir, "v", "m");
  voice.say("hello there");
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ["[voice] hello there"]);
});

test("lines play one at a time, in the order they were said", async () => {
  const order: string[] = [];
  behave = async (n) => {
    order.push(`fetch ${n}`);
    await delay(n === 1 ? 80 : 0); // the first line is the slow one
    return new Response("X");
  };
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("first");
  voice.say("second");
  voice.say("third");
  await until(() => speeches.length === 3);
  assert.deepEqual(speeches.map((s) => s.text), ["first", "second", "third"]);
});

test("a failed synthesis is logged, nothing is emitted, and the next line still plays", async () => {
  behave = (n) => (n === 1 ? new Response("quota exceeded: " + "x".repeat(500), { status: 401 }) : new Response("X"));
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("will fail");
  voice.say("will work");
  await until(() => speeches.length === 1);
  assert.equal(speeches[0].text, "will work");
  const message = String(errors.mock.calls[0].arguments[1]);
  assert.match(message, /^ElevenLabs 401: quota exceeded/);
  assert.ok(message.length < 230, "the error body is cut to 200 characters");
  assert.equal(errors.mock.calls[0].arguments[0], "[voice]");
});

test("a failed line is not cached: saying it again retries the API", async () => {
  behave = (n) => (n === 1 ? new Response("down", { status: 503 }) : new Response("X"));
  const voice = new Voice("browser", ttsDir, "v", "m");
  const speeches = listen(voice);
  voice.say("retry me");
  await until(() => errors.mock.callCount() === 1);
  voice.say("retry me");
  await until(() => speeches.length === 1);
  assert.equal(calls.length, 2);
});

test("a network error is logged like any other failure", async () => {
  behave = () => Promise.reject(new TypeError("fetch failed"));
  const voice = new Voice("browser", ttsDir, "v", "m");
  voice.say("offline");
  await until(() => errors.mock.callCount() === 1);
  assert.equal(errors.mock.calls[0].arguments[1], "fetch failed");
});

test("prepare swallows a failure into the log instead of crashing the process", async () => {
  behave = () => new Response("nope", { status: 500 });
  const voice = new Voice("browser", ttsDir, "v", "m");
  voice.prepare("will not synthesize");
  await until(() => errors.mock.callCount() === 1);
  assert.match(String(errors.mock.calls[0].arguments[1]), /ElevenLabs 500/);
});

// ── host playback (afplay), with a stand-in on PATH so no audio can play ────────────────────────────

function fakeAfplay(exitCode = 0) {
  const bin = join(t.root, "bin");
  mkdirSync(bin, { recursive: true });
  const record = join(t.root, "afplay.log");
  writeFileSync(join(bin, "afplay"), `#!/bin/sh\necho "$@" >> "${record}"\nexit ${exitCode}\n`);
  chmodSync(join(bin, "afplay"), 0o755);
  const restore = withEnv({ PATH: `${bin}:${process.env.PATH}` });
  return { record, restore };
}

test("host mode: plays the mp3 with afplay and does not tell browsers to", async () => {
  const afplay = fakeAfplay();
  try {
    const voice = new Voice("host", ttsDir, "v", "m");
    const speeches = listen(voice);
    voice.say("on the host");
    await until(() => existsSync(afplay.record));
    await until(() => speeches.length === 1);
    const path = join(ttsDir, `${hashOf("v", "m", "on the host")}.mp3`);
    assert.equal(readFileSync(afplay.record, "utf8").trim(), path);
    assert.equal(speeches[0].browser, false);
    assert.equal(speeches[0].url, `/api/tts/${hashOf("v", "m", "on the host")}.mp3`);
  } finally {
    afplay.restore();
  }
});

test("both mode: browsers are told and the host plays too", async () => {
  const afplay = fakeAfplay();
  try {
    const voice = new Voice("both", ttsDir, "v", "m");
    const speeches = listen(voice);
    voice.say("everywhere");
    await until(() => existsSync(afplay.record) && speeches.length === 1);
    assert.equal(speeches[0].browser, true);
  } finally {
    afplay.restore();
  }
});

test("host mode: the next line waits for afplay to finish, and a failing player does not stop the queue", async () => {
  const afplay = fakeAfplay(1);
  try {
    const voice = new Voice("host", ttsDir, "v", "m");
    const speeches = listen(voice);
    voice.say("one");
    voice.say("two");
    await until(() => speeches.length === 2);
    await until(() => readFileSync(afplay.record, "utf8").trim().split("\n").length === 2);
    assert.equal(errors.mock.callCount(), 0, "a nonzero exit is not an error");
  } finally {
    afplay.restore();
  }
});

test("host mode: a missing afplay (any non-macOS machine) is swallowed", async () => {
  const restore = withEnv({ PATH: join(t.root, "empty-bin") });
  try {
    const voice = new Voice("host", ttsDir, "v", "m");
    const speeches = listen(voice);
    voice.say("no player");
    voice.say("still alive");
    await until(() => speeches.length === 2);
  } finally {
    restore();
  }
});
