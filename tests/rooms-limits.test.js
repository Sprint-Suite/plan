// @ts-check
/**
 * M2 resource limits on the rooms service, each exercised against a real server
 * instance with small overridden limits and an injectable clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { openDb, createRoom, loadRoom } from "../server/db.js";
import { startSpikeServer } from "../server/server.js";
import { applyOp } from "../server/rooms.js";
import { registerTestSession } from "../server/auth-seam.js";
import { createInitialState, reduce } from "../public/js/store.js";
import { createRoomStore } from "../public/js/sync-client.js";

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
async function until(/** @type {() => boolean} */ pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await wait(10);
  }
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
}

/** @param {any} [opts] */
async function boot(opts = {}) {
  const db = opts.db ?? openDb(":memory:");
  if (!opts.db) {
    createRoom(db, { id: "r", companyId: "acme", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
    createRoom(db, { id: "r2", companyId: "acme", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
    createRoom(db, { id: "co", companyId: "acme", shareToken: "t", mode: "company-only", doc: createInitialState("2026-01-05") });
  }
  const server = await startSpikeServer({ db, ...opts, db: opts.dbHandle ?? db });
  return { db, server };
}

/**
 * Connect and collect frames. Resolves once the state frame arrives, or with
 * { refused } when the upgrade is rejected.
 * @returns {Promise<any>}
 */
function join(/** @type {any} */ server, query = "room=r&token=t&name=x", headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server.url}/?${query}`, { headers });
    const frames = /** @type {any[]} */ ([]);
    const client = { ws, frames, closeCode: /** @type {number | null} */ (null) };
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      frames.push(m);
      if (m.type === "state") resolve(client);
    });
    ws.on("close", (code) => { client.closeCode = code; });
    ws.on("unexpected-response", (_req, res) => resolve({ refused: res.statusCode }));
    ws.on("error", () => {});
  });
}

const op = (/** @type {string} */ opId, /** @type {any} */ o) => JSON.stringify({ type: "op", opId, op: o });
const titleOp = (/** @type {string} */ opId, /** @type {string} */ title) => op(opId, { type: "SET_PLAN_TITLE", payload: title });
const of = (/** @type {any} */ c, /** @type {string} */ type) => c.frames.filter((/** @type {any} */ f) => f.type === type);

// --- document size -----------------------------------------------------------

test("applyOp measures the document in UTF-8 bytes, not characters", () => {
  const db = openDb(":memory:");
  createRoom(db, { id: "r", companyId: "c", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
  const room = /** @type {any} */ (loadRoom(db, "r"));
  const limits = { maxDocBytes: 20_000 };
  assert.equal(applyOp(db, room, { type: "SET_PLAN_TITLE", payload: "a".repeat(8000) }, limits).ok, true);
  const multibyte = applyOp(db, room, { type: "SET_PLAN_TITLE", payload: "€".repeat(8000) }, limits);
  assert.equal(multibyte.ok, false);
  assert.equal(room.version, 1);
  assert.equal(/** @type {any} */ (loadRoom(db, "r")).version, 1);
});

test("POST /rooms refuses an imported plan over the document cap", async () => {
  registerTestSession("cap-tok", { userId: "cap-user", company: "acme", entitled: true });
  const { db, server } = await boot({ limits: { maxDocBytes: 5000 } });
  const plan = createInitialState("2026-01-05");
  plan.meta.title = "x".repeat(6000);
  const res = await fetch(`${server.httpUrl}/rooms`, {
    method: "POST", headers: { "content-type": "application/json", "x-spike-session": "cap-tok" },
    body: JSON.stringify({ mode: "open-link", plan }),
  });
  assert.equal(res.status, 413);
  server.close(); db.close();
});

test("a room imported with a 70 KiB summary can still be edited (frame cap fits any permitted op)", async () => {
  registerTestSession("big-tok", { userId: "big-user", company: "acme", entitled: true });
  const { db, server } = await boot();
  let plan = createInitialState("2026-01-05");
  plan = reduce(plan, { type: "ADD_STORY", payload: { id: "s", title: "S", summary: "y".repeat(70 * 1024), points: 1, epicId: null } });
  const res = await fetch(`${server.httpUrl}/rooms`, {
    method: "POST", headers: { "content-type": "application/json", "x-spike-session": "big-tok" },
    body: JSON.stringify({ mode: "open-link", plan }),
  });
  const { id, shareToken } = await res.json();
  const ws = new WebSocket(`${server.url}/?room=${id}&token=${shareToken}&name=x`);
  const acks = /** @type {any[]} */ ([]);
  const store = createRoomStore({
    transport: {
      send: (m) => ws.send(JSON.stringify(m)),
      onMessage: (cb) => ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "op") acks.push(m); cb(m); }),
      onOpen: (cb) => ws.on("open", cb), onClose: (cb) => ws.on("close", cb), close: () => ws.close(),
    },
  });
  await until(() => Object.hasOwn(store.getState().stories, "s"));
  store.dispatch({ type: "EDIT_STORY", payload: { id: "s", title: "S", summary: "y".repeat(70 * 1024) + "z", points: 1, epicId: null } });
  await until(() => acks.length === 1);
  ws.terminate(); server.close(); db.close();
});

// --- frames and rates --------------------------------------------------------

test("an oversized frame closes only that socket", async () => {
  const { db, server } = await boot({ limits: { maxFrameBytes: 1000 } });
  const a = await join(server);
  const b = await join(server);
  a.ws.send(titleOp("1", "x".repeat(2000)));
  await until(() => a.closeCode !== null);
  assert.equal(a.closeCode, 1009);
  b.ws.send(titleOp("2", "ok"));
  await until(() => of(b, "op").length === 1);
  b.ws.terminate(); server.close(); db.close();
});

test("ops past the per-socket bucket are nacked and accepted again after refill", async () => {
  const c = clock();
  const { db, server } = await boot({ limits: { opRate: 1, opBurst: 2 }, now: c.now });
  const a = await join(server);
  for (const id of ["1", "2", "3"]) a.ws.send(titleOp(id, `t${id}`));
  await until(() => of(a, "op").length + of(a, "nack").length === 3);
  assert.deepEqual(of(a, "nack").map((/** @type {any} */ n) => n.opId), ["3"]);
  c.advance(1000);
  a.ws.send(titleOp("4", "t4"));
  await until(() => of(a, "op").length === 3);
  a.ws.terminate(); server.close(); db.close();
});

test("cursor positions are rate limited and repeated 'gone' frames relay once", async () => {
  const c = clock();
  const { db, server } = await boot({ limits: { cursorRate: 1, cursorBurst: 2 }, now: c.now });
  const a = await join(server);
  const b = await join(server);
  for (let i = 0; i < 4; i++) a.ws.send(JSON.stringify({ type: "cursor", x: 0.1 * i, y: 0.5 }));
  for (let i = 0; i < 5; i++) a.ws.send(JSON.stringify({ type: "cursor", gone: true }));
  a.ws.send(titleOp("fence", "f")); // ordering fence: everything before it has been handled
  await until(() => of(b, "op").length === 1);
  const cursors = of(b, "cursor");
  assert.equal(cursors.filter((/** @type {any} */ f) => !f.gone).length, 2, "positions past the bucket dropped");
  assert.equal(cursors.filter((/** @type {any} */ f) => f.gone).length, 1, "the visible cursor is removed exactly once");
  a.ws.terminate(); b.ws.terminate(); server.close(); db.close();
});

test("the client name is trimmed and capped at 40 characters", async () => {
  const { db, server } = await boot();
  const a = await join(server, `room=r&token=t&name=${encodeURIComponent("  " + "n".repeat(100))}`);
  const presence = of(a, "presence").at(-1) ?? (await until(() => of(a, "presence").length > 0), of(a, "presence").at(-1));
  assert.equal(presence.participants[0].name, "n".repeat(40));
  a.ws.terminate(); server.close(); db.close();
});

// --- connections -------------------------------------------------------------

test("a room refuses sockets beyond its cap, and the service beyond its total", async () => {
  const { db, server } = await boot({ limits: { maxRoomSockets: 2, maxTotalSockets: 3 } });
  const a = await join(server);
  const b = await join(server);
  assert.equal((await join(server)).refused, 503, "room full");
  const c = await join(server, "room=r2&token=t&name=x");
  assert.equal((await join(server, "room=r2&token=t&name=x")).refused, 503, "service full");
  for (const s of [a, b, c]) s.ws.terminate();
  server.close(); db.close();
});

/** An anonymous auth provider that answers after `ms` and counts calls. */
function slowAuth(/** @type {number} */ ms) {
  const calls = { n: 0 };
  return {
    calls,
    provider: {
      mode: "stub",
      verifySession: () => { calls.n++; return new Promise((r) => setTimeout(() => r(null), ms)); },
      requireAuth: (/** @type {any} */ _q, /** @type {any} */ res) => res.status(401).end(),
      companyOf: () => null, userOf: () => null, mountRoutes: () => {},
    },
  };
}

test("upgrades beyond the pending ceiling are refused", async () => {
  const { provider } = slowAuth(150);
  const { db, server } = await boot({ auth: provider, limits: { maxPendingUpgrades: 1 } });
  const [first, second] = await Promise.all([join(server), join(server)]);
  assert.deepEqual([first.refused, second.refused].sort(), [503, undefined].sort());
  for (const s of [first, second]) s.ws?.terminate();
  server.close(); db.close();
});

test("an exhausted upgrade bucket refuses before any auth or database work", async () => {
  const c = clock();
  const { calls, provider } = slowAuth(0);
  const real = openDb(":memory:");
  createRoom(real, { id: "r", companyId: "acme", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
  const reads = { n: 0 };
  const counted = new Proxy(real, {
    get(t, k) {
      if (k === "prepare") return (/** @type {string} */ sql) => { reads.n++; return t.prepare(sql); };
      const v = /** @type {any} */ (t)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const { server } = await boot({ db: real, dbHandle: counted, auth: provider, now: c.now, limits: { upgradeRate: 1, upgradeBurst: 1 } });
  const a = await join(server);
  const before = { auth: calls.n, reads: reads.n };
  assert.equal((await join(server)).refused, 503);
  assert.deepEqual({ auth: calls.n, reads: reads.n }, before);
  c.advance(1000);
  const b = await join(server);
  assert.equal(b.refused, undefined);
  a.ws.terminate(); b.ws.terminate(); server.close(); real.close();
});

// --- one authoritative room object, and eviction ------------------------------

test("a joiner admitted after a slow auth sees commits made during the wait", async () => {
  const { provider } = slowAuth(150);
  const { db, server } = await boot({ auth: provider });
  const a = await join(server);
  const pending = join(server);
  await wait(30);
  a.ws.send(titleOp("1", "during-auth"));
  const b = await pending;
  const state = of(b, "state")[0];
  assert.equal(state.doc.meta.title, "during-auth");
  assert.equal(state.version, 1);
  b.ws.send(titleOp("2", "from-b"));
  a.ws.send(titleOp("3", "from-a"));
  await until(() => of(a, "op").length === 3 && of(b, "op").length === 2);
  assert.deepEqual(of(a, "op").map((/** @type {any} */ f) => f.version), [1, 2, 3]);
  assert.equal(/** @type {any} */ (loadRoom(db, "r")).version, 3);
  a.ws.terminate(); b.ws.terminate(); server.close(); db.close();
});

test("rejected joins never populate the room cache", async () => {
  registerTestSession("globex-tok-m2", { userId: "g1", company: "globex", entitled: true });
  const { db, server } = await boot();
  assert.equal((await join(server, "room=r&token=wrong&name=x")).refused, 403);
  assert.equal((await join(server, "room=co&name=x", { "x-spike-session": "globex-tok-m2" })).refused, 403);
  assert.equal(server.cacheSize(), 0);
  server.close(); db.close();
});

test("the last leave evicts the room, and a rejoin reloads it with its changes", async () => {
  const { db, server } = await boot();
  const a = await join(server);
  assert.equal(server.cacheSize(), 1);
  a.ws.send(titleOp("1", "kept"));
  await until(() => of(a, "op").length === 1);
  a.ws.close();
  await until(() => server.cacheSize() === 0);
  const b = await join(server);
  assert.equal(of(b, "state")[0].doc.meta.title, "kept");
  b.ws.terminate(); server.close(); db.close();
});

// --- backpressure -------------------------------------------------------------

test("a broadcast recipient that stops reading is cut off", async () => {
  const { db, server } = await boot({ limits: { maxBufferedBytes: 256 * 1024, opRate: 10_000, opBurst: 10_000 } });
  const a = await join(server);
  const b = await join(server);
  /** @type {any} */ (b.ws)._socket.pause();
  // Paced, so the reading sender keeps up while the paused recipient falls behind.
  for (let i = 0; i < 1000; i++) {
    a.ws.send(titleOp(String(i), "x".repeat(60 * 1024)));
    if (i % 5 === 4) await wait(5);
  }
  await until(() => b.closeCode !== null || server.socketCount("r") === 1, 10_000);
  await until(() => of(a, "op").length === 1000, 10_000);
  assert.equal(server.socketCount("r"), 1, "the reading sender is still connected");
  assert.equal(a.closeCode, null);
  a.ws.terminate(); b.ws.terminate(); server.close(); db.close();
});

test("a sender that stops reading its own nacks is cut off", async () => {
  const c = clock();
  const { db, server } = await boot({ limits: { maxBufferedBytes: 16 * 1024, opRate: 0.001, opBurst: 0 }, now: c.now });
  const a = await join(server);
  /** @type {any} */ (a.ws)._socket.pause();
  const frame = titleOp("op_padding_to_make_each_nack_bigger_000000000000000000000", "x");
  for (let i = 0; i < 40_000; i++) a.ws.send(frame);
  await until(() => server.socketCount("r") === 0, 10_000);
  a.ws.terminate(); server.close(); db.close();
});

// --- room creation ------------------------------------------------------------

test("room creation is limited per user, independently", async () => {
  registerTestSession("rl-u1", { userId: "rl-1", company: "acme", entitled: true });
  registerTestSession("rl-u2", { userId: "rl-2", company: "acme", entitled: true });
  const { db, server } = await boot({ limits: { roomsPerUserPerHour: 2 } });
  const create = (/** @type {string} */ tok) => fetch(`${server.httpUrl}/rooms`, {
    method: "POST", headers: { "content-type": "application/json", "x-spike-session": tok }, body: "{}",
  }).then((r) => r.status);
  assert.deepEqual([await create("rl-u1"), await create("rl-u1"), await create("rl-u1")], [200, 200, 429]);
  assert.equal(await create("rl-u2"), 200);
  server.close(); db.close();
});

test("a client that floods pings but never reads is cut off (pongs are guarded too)", async () => {
  const { db, server } = await boot({ limits: { maxBufferedBytes: 16 * 1024 } });
  const a = await join(server);
  /** @type {any} */ (a.ws)._socket.pause();
  const payload = Buffer.alloc(125, 1);
  for (let i = 0; i < 40_000; i++) a.ws.ping(payload);
  await until(() => server.socketCount("r") === 0, 10_000);
  a.ws.terminate(); server.close(); db.close();
});

test("a failed room creation does not use up the creator's quota", async () => {
  registerTestSession("rl-fail", { userId: "rl-fail-user", company: "acme", entitled: true });
  const { db, server } = await boot({ limits: { roomsPerUserPerHour: 1 } });
  const create = () => fetch(`${server.httpUrl}/rooms`, {
    method: "POST", headers: { "content-type": "application/json", "x-spike-session": "rl-fail" }, body: "{}",
  }).then((r) => r.status);
  db.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON rooms BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  assert.equal(await create(), 500);
  db.exec("DROP TRIGGER refuse_insert");
  assert.equal(await create(), 200);
  server.close(); db.close();
});
