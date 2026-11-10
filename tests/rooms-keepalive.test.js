// @ts-check
/**
 * Idle room connections are kept alive by server pings (so proxies in front of
 * the service never see a silent tunnel), and a connection that stops
 * answering is cleaned up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { openDb, createRoom } from "../server/db.js";
import { startSpikeServer } from "../server/server.js";
import { createInitialState } from "../public/js/store.js";

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const db = openDb(":memory:");
  createRoom(db, { id: "r", companyId: "acme", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
  const server = await startSpikeServer({ db, limits: { pingIntervalMs: 50 } });
  return { db, server };
}

function join(/** @type {any} */ server, /** @type {any} */ opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server.url}/?room=r&token=t&name=x`, opts);
    const client = { ws, pings: 0, closed: false };
    ws.on("ping", () => { client.pings++; });
    ws.on("close", () => { client.closed = true; });
    ws.once("message", () => resolve(client));
  });
}

test("an idle connection that answers pings stays open", async () => {
  const { db, server } = await boot();
  const c = /** @type {any} */ (await join(server));
  await wait(400);
  assert.ok(c.pings >= 3, `expected regular pings, got ${c.pings}`);
  assert.equal(c.closed, false);
  assert.equal(server.socketCount("r"), 1);
  c.ws.terminate(); server.close(); db.close();
});

test("a connection that stops answering pings is cut off", async () => {
  const { db, server } = await boot();
  const c = /** @type {any} */ (await join(server, { autoPong: false }));
  await wait(400);
  assert.equal(server.socketCount("r"), 0);
  c.ws.terminate(); server.close(); db.close();
});
