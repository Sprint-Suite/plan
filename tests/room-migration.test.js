// @ts-check
/**
 * Rooms pass through the same schema migration as every other load path:
 * stored legacy rows on load, imported plans on creation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { openDb, loadRoom } from "../server/db.js";
import { startSpikeServer } from "../server/server.js";
import { registerTestSession } from "../server/auth-seam.js";
import { createInitialState, reduce } from "../public/js/store.js";

/** @type {any} */ let db;
/** @type {any} */ let server;

/** A valid plan with one backlog story, stamped as an older schema version. */
function legacyPlan(/** @type {number} */ version) {
  const p = reduce(createInitialState("2026-07-06"), {
    type: "ADD_STORY", payload: { id: "s1", title: "Old", summary: "", points: 2, epicId: null },
  });
  return { ...p, meta: { ...p.meta, schemaVersion: version } };
}

before(async () => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO rooms (id, company_id, share_token, mode, plan_json, version, updated_at)
              VALUES ('legacy', 'acme', 't', 'open-link', ?, 4, '2026-01-01T00:00:00Z')`).run(JSON.stringify(legacyPlan(2)));
  registerTestSession("migrate-tok", { userId: "u1", company: "acme", entitled: true });
  server = await startSpikeServer({ db });
});
after(() => { server.close(); db.close(); });

test("a stored v2 room loads as v3, accepts an edit, and persists as v3", async () => {
  const ws = new WebSocket(`${server.url}/?room=legacy&token=t&name=x`);
  const frames = /** @type {any[]} */ ([]);
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  const until = async (/** @type {(f: any) => boolean} */ pred) => {
    for (let i = 0; i < 200 && !frames.some(pred); i++) await new Promise((r) => setTimeout(r, 10));
    return frames.find(pred);
  };

  try {
    const state = await until((f) => f.type === "state");
    assert.equal(state.doc.meta.schemaVersion, 3);

    ws.send(JSON.stringify({ type: "op", opId: "op_1", op: { type: "EDIT_STORY", payload: { id: "s1", title: "Renamed" } } }));
    const ack = await until((f) => f.type === "op" || f.type === "nack");
    assert.equal(ack?.type, "op", `expected an ack, got ${JSON.stringify(ack)}`);

    const stored = /** @type {any} */ (JSON.parse(db.prepare("SELECT plan_json FROM rooms WHERE id = 'legacy'").get().plan_json));
    assert.equal(stored.meta.schemaVersion, 3);
    assert.equal(stored.stories.s1.title, "Renamed");
  } finally {
    ws.terminate();
  }
});

test("POST /rooms stores an imported v2 plan as v3", async () => {
  const res = await fetch(`${server.httpUrl}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spike-session": "migrate-tok" },
    body: JSON.stringify({ mode: "open-link", plan: legacyPlan(2) }),
  });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.equal(/** @type {any} */ (loadRoom(db, id)).doc.meta.schemaVersion, 3);
  const stored = /** @type {any} */ (JSON.parse(db.prepare("SELECT plan_json FROM rooms WHERE id = ?").get(id).plan_json));
  assert.equal(stored.meta.schemaVersion, 3);
});
