import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import express from "express";
import { guard } from "../apps/dpi-playground-hub/src/guard.js";
import { rawRequest } from "./support.js";

let server: Server;
let base = "";
let port = 0;
let host = "";

before(async () => {
  const app = express();
  // The same wiring as main.ts: guard first, then the JSON body parser.
  app.use(
    guard(new Set(["localhost:4781", "127.0.0.1:4781", "[::1]:4781", "box.local:4781"])),
    express.json(),
  );
  app.all("/ok", (req, res) =>
    res.json({ reached: true, method: req.method, body: req.body ?? null }),
  );
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  // The guard's allow-list is fixed, so every request names one of its hosts explicitly.
  host = "127.0.0.1:4781";
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const get = (path = "/ok", extra: Parameters<typeof rawRequest>[2] = {}) =>
  rawRequest(base, path, { host, ...extra });
const errorCode = (text: string) => (JSON.parse(text) as { error: { code: string } }).error.code;

describe("guard: Host header", () => {
  test("a listed Host passes", async () => {
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).reached, true);
  });

  test("every listed Host form passes, whatever its case", async () => {
    for (const h of ["localhost:4781", "LOCALHOST:4781", "[::1]:4781", "Box.Local:4781"])
      assert.equal((await get("/ok", { host: h })).status, 200, h);
  });

  test("an unknown Host is 421 with the invalid code and names the host", async () => {
    const r = await get("/ok", { host: "evil.test" });
    assert.equal(r.status, 421);
    assert.equal(errorCode(r.text), "invalid");
    assert.match(JSON.parse(r.text).error.message, /Unknown Host header: evil\.test/);
  });

  test("the right host on the wrong port is rejected (rebinding to another local service)", async () => {
    assert.equal((await get("/ok", { host: "127.0.0.1:4782" })).status, 421);
    assert.equal((await get("/ok", { host: "127.0.0.1" })).status, 421);
  });

  test("a host that only starts or ends like a listed one is rejected", async () => {
    for (const h of [
      "localhost:4781.evil.test",
      "evil.localhost:4781",
      "xlocalhost:4781",
      "localhost:47810",
    ])
      assert.equal((await get("/ok", { host: h })).status, 421, h);
  });

  test("a request with no Host header at all is rejected", async () => {
    // HTTP/1.0 allows it. Fetch and http.request always add one, so write the request by hand.
    const text = await new Promise<string>((done, fail) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /ok HTTP/1.0\r\n\r\n"));
      let data = "";
      socket.on("data", (x) => (data += x));
      socket.on("end", () => done(data));
      socket.on("error", fail);
    });
    assert.match(text, /^HTTP\/1\.1 421 /);
  });

  test("the Host check runs before anything else: a bad host with a bad origin and a non-JSON write is 421", async () => {
    const r = await get("/ok", {
      host: "evil.test",
      method: "POST",
      headers: { origin: "http://evil.test", "content-type": "text/plain" },
      body: "x",
    });
    assert.equal(r.status, 421);
  });
});

describe("guard: cross-origin requests", () => {
  test("no Origin header (a script, curl, same-origin GET) passes", async () => {
    assert.equal((await get()).status, 200);
  });

  test("an Origin equal to the Host passes, whatever its scheme, case or path", async () => {
    for (const origin of [
      "http://127.0.0.1:4781",
      "https://127.0.0.1:4781",
      "HTTP://127.0.0.1:4781/some/page",
    ])
      assert.equal((await get("/ok", { headers: { origin } })).status, 200, origin);
  });

  test("an Origin on another host is 403 unauthorized", async () => {
    const r = await get("/ok", { headers: { origin: "http://evil.test" } });
    assert.equal(r.status, 403);
    assert.equal(errorCode(r.text), "unauthorized");
    assert.match(JSON.parse(r.text).error.message, /Cross-origin/);
  });

  test("an Origin on the same host but another port is 403", async () => {
    assert.equal((await get("/ok", { headers: { origin: "http://127.0.0.1:9999" } })).status, 403);
    assert.equal((await get("/ok", { headers: { origin: "http://localhost:4781" } })).status, 403);
  });

  test("an unparseable or opaque Origin is 403, never a pass", async () => {
    for (const origin of ["null", "not a url", "://", "file:///etc/passwd"])
      assert.equal((await get("/ok", { headers: { origin } })).status, 403, origin);
  });

  test("a cross-origin GET is refused too, not only writes", async () => {
    const r = await get("/ok", { method: "GET", headers: { origin: "http://evil.test" } });
    assert.equal(r.status, 403);
  });

  test("the origin check runs before the content-type check", async () => {
    const r = await get("/ok", {
      method: "PUT",
      headers: { origin: "http://evil.test", "content-type": "text/plain" },
      body: "x",
    });
    assert.equal(r.status, 403);
  });
});

describe("guard: writes must be JSON", () => {
  for (const method of ["POST", "PUT", "PATCH"]) {
    test(`${method} with a JSON body reaches the handler`, async () => {
      const r = await get("/ok", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text).body, { a: 1 });
    });

    test(`${method} with a form or text body is 415`, async () => {
      for (const type of [
        "application/x-www-form-urlencoded",
        "text/plain",
        "multipart/form-data; boundary=x",
      ]) {
        const r = await get("/ok", { method, headers: { "content-type": type }, body: "a=1" });
        assert.equal(r.status, 415, type);
        assert.equal(errorCode(r.text), "invalid");
      }
    });

    test(`${method} with no body is 415`, async () => {
      assert.equal((await get("/ok", { method })).status, 415);
    });
  }

  test("a JSON content type with a charset, or in capitals, is accepted", async () => {
    for (const type of [
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "APPLICATION/JSON",
    ])
      assert.equal(
        (await get("/ok", { method: "POST", headers: { "content-type": type }, body: "{}" }))
          .status,
        200,
        type,
      );
  });

  test("GET and HEAD need no content type", async () => {
    assert.equal((await get("/ok", { method: "GET" })).status, 200);
    assert.equal((await get("/ok", { method: "HEAD" })).status, 200);
  });

  test("the 415 body names the problem", async () => {
    const r = await get("/ok", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    assert.equal(JSON.parse(r.text).error.message, "JSON required");
  });
});

describe("guard: errors never reach the next handler", () => {
  test("a rejected request does not run the route", async () => {
    let reached = 0;
    const app = express();
    app.use(guard(new Set(["h:1"])));
    app.use((_req, res) => (reached++, res.end("ok")));
    const s = createServer(app);
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      await rawRequest(b, "/", { host: "evil.test" });
      await rawRequest(b, "/", { host: "h:1", headers: { origin: "http://evil.test" } });
      await rawRequest(b, "/", {
        host: "h:1",
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      });
      assert.equal(reached, 0);
      assert.equal((await rawRequest(b, "/", { host: "h:1" })).text, "ok");
      assert.equal(reached, 1);
    } finally {
      s.closeAllConnections();
      s.close();
    }
  });
});
