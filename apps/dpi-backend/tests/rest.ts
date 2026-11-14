// A real dpi-backend child process (faux provider, temp DPI_HOME, ephemeral port) plus small REST helpers, shared by
// the routes-*.test.ts files. Each test file boots its own server in `before` and stops it in `after`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

export type Envelope = { error: { code: string; message: string } };
export type Reply<T = any> = { status: number; headers: Headers; body: T };

export async function startRest(name = "routes-box") {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name });
  let n = 0;

  const call = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    const res = await fetch(server.base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: parsed as T };
  };

  /** Assert an error envelope with this status and code, and optionally a message (exact string or pattern). */
  const errorOf = (r: Reply, status: number, code: string, message?: RegExp | string) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    const e = (r.body as Envelope).error;
    assert.equal(e?.code, code, JSON.stringify(r.body));
    if (message instanceof RegExp) assert.match(e.message, message);
    else if (message !== undefined) assert.equal(e.message, message);
  };

  /** A fresh session, so tests never share agent state. */
  const newSession = async (sessionName = `S${++n}`) => {
    const r = await call("POST", "/v1/sessions", { name: sessionName, cwd: t.work, model: faux });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id as string;
    return { id, base: `/v1/sessions/${id}`, main: `/v1/sessions/${id}/agents/main` };
  };

  /** Send a message and wait for the answer text. */
  const ask = async (main: string, content: string, requestId = `req-${++n}`) => {
    const r = await call("POST", `${main}/messages`, { content, requestId, waitMs: 20000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.answer.text as string;
  };

  const busy = async (session: { base: string }) => (await call("GET", session.base)).body.busy as boolean;

  return {
    t,
    token,
    server,
    call,
    errorOf,
    newSession,
    ask,
    busy,
    stop: async () => {
      await server.stop();
      await t.cleanup();
    },
  };
}
