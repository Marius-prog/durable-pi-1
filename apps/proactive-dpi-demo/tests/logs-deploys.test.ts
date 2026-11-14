import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeCheckoutRepo, tempDir } from "./helpers.ts";
import { loadRevision, type Revision } from "../apps/proactive-dpi-logs/src/deploys.ts";

const t = tempDir();
const dataDir = join(t.root, "data");
let repoDir: string;
let good: Revision;
let bad: Revision;

before(async () => {
  repoDir = makeCheckoutRepo(t.root);
  const where = { repoDir, dataDir };
  good = await loadRevision("HEAD~1", "checkout-api-00041-rup", where);
  bad = await loadRevision("HEAD", "checkout-api-00042-vex", where);
});
after(() => t.cleanup());

const cart = {
  id: "cart_1",
  currency: "USD",
  items: [{ sku: "lamp-01", name: "Arc desk lamp", unitCents: 4500, quantity: 2 }],
};
const member = { id: "cus_1", guest: false, region: "us-ca", loyalty: { tier: "gold", points: 500 } };
const guest = { id: "gst_1", guest: true, region: "us-ny" };

test("loadRevision: names the revision after its commit and exports a checkout handler", () => {
  assert.equal(good.name, "checkout-api-00041-rup");
  assert.equal(good.commit, git(repoDir, "rev-parse", "--short", "HEAD~1"));
  assert.equal(good.subject, "feat(pricing): regional tax rates");
  assert.equal(bad.commit, git(repoDir, "rev-parse", "--short", "HEAD"));
  assert.equal(bad.subject, "feat(pricing): apply loyalty tier discounts at checkout");
  assert.notEqual(good.commit, bad.commit);
  assert.equal(typeof good.handleCheckout, "function");
});

test("loadRevision: archives each revision into data/deploys/<name>-<commit>", () => {
  const dirs = readdirSync(join(dataDir, "deploys")).sort();
  assert.deepEqual(dirs, [`${good.name}-${good.commit}`, `${bad.name}-${bad.commit}`].sort());
  assert.ok(existsSync(join(dataDir, "deploys", dirs[0], "src/routes/checkout.ts")));
  assert.equal(existsSync(join(dataDir, "deploys", dirs[0], ".git")), false, "git archive carries no history");
});

test("loadRevision: the good revision serves members and guests, and declines test tokens", async () => {
  const member200 = await good.handleCheckout({ cart, customer: member, paymentToken: "tok_abcdef123456" });
  assert.equal(member200.status, 200);
  assert.match(String(member200.body.orderId), /^ord_/);
  const guest200 = await good.handleCheckout({ cart, customer: guest, paymentToken: "tok_abcdef123456" });
  assert.equal(guest200.status, 200);
  const declined = await good.handleCheckout({ cart, customer: member, paymentToken: "tok_decline_abc" });
  assert.deepEqual(declined, { status: 402, body: { error: "card_declined" } });
});

test("loadRevision: the bad revision breaks guest checkout with a TypeError and still serves members", async () => {
  const ok = await bad.handleCheckout({ cart, customer: member, paymentToken: "tok_abcdef123456" });
  assert.equal(ok.status, 200);
  await assert.rejects(
    () => bad.handleCheckout({ cart, customer: guest, paymentToken: "tok_abcdef123456" }),
    (e: Error) => e instanceof TypeError && /tier|undefined/.test(e.message),
  );
});

test("loadRevision: rolling out the same ref twice reuses the archived directory", async () => {
  const again = await loadRevision("HEAD", "checkout-api-00042-vex", { repoDir, dataDir });
  assert.equal(again.commit, bad.commit);
  assert.equal(readdirSync(join(dataDir, "deploys")).length, 2);
});

test("loadRevision: a ref that does not exist throws", async () => {
  await assert.rejects(() => loadRevision("no-such-ref", "x", { repoDir, dataDir }), /no-such-ref|unknown revision/);
});

test("loadRevision: a missing repo says to run reset", async () => {
  await assert.rejects(
    () => loadRevision("HEAD", "x", { repoDir: join(t.root, "nope"), dataDir }),
    /Missing mock repo at .*nope\. Run npm run reset first\./,
  );
});

test("containerStack: rewrites local frames to what the container prints and appends the server frame", async () => {
  let stack = "";
  try {
    await bad.handleCheckout({ cart, customer: guest, paymentToken: "tok_abcdef123456" });
  } catch (e) {
    stack = (e as Error).stack!;
  }
  assert.ok(stack, "the guest checkout threw");
  const out = bad.containerStack(stack).split("\n");
  assert.match(out[0], /^TypeError: /, "first line is the error header");
  for (const line of out.slice(1)) {
    assert.ok(!line.includes(dataDir), `no host paths leak: ${line}`);
    assert.ok(!line.includes(t.root), `no temp paths leak: ${line}`);
  }
  assert.ok(out.some((l) => l.includes("file:///workspace/src/pricing/loyalty.ts")), out.join("\n"));
  // Frames from outside the revision (node internals) are dropped.
  assert.ok(out.every((l, i) => i === 0 || l.includes("file:///workspace")), out.join("\n"));
  const last = out.at(-1)!;
  assert.match(last, /^ {4}at Server\.<anonymous> \(file:\/\/\/workspace\/src\/server\.ts:\d+:\d+\)$/);
});

test("containerStack: points the server frame at the real handleCheckout call", () => {
  const frame = bad.containerStack("Error: boom").split("\n");
  assert.equal(frame[0], "Error: boom");
  assert.equal(frame.length, 2);
  const [, line, column] = /server\.ts:(\d+):(\d+)\)$/.exec(frame[1])!;
  const source = readFileSync(join(dataDir, "deploys", `${bad.name}-${bad.commit}`, "src/server.ts"), "utf8").split("\n");
  assert.ok(source[Number(line) - 1].includes("handleCheckout(JSON"));
  assert.equal(source[Number(line) - 1].indexOf("handleCheckout") + 1, Number(column));
});
