// @ts-check
/**
 * applyOp never throws: a malformed op or a failed save is a rejection the
 * server can nack, and the room document is left untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb, createRoom, loadRoom } from "../server/db.js";
import { applyOp } from "../server/rooms.js";
import { createInitialState } from "../public/js/store.js";

function freshRoom() {
  const db = openDb(":memory:");
  createRoom(db, { id: "r", companyId: "c", shareToken: "t", mode: "open-link", doc: createInitialState("2026-01-05") });
  return { db, room: /** @type {any} */ (loadRoom(db, "r")) };
}

const MALFORMED = [
  { name: "non-string type with a non-callable toString", op: { type: { toString: null }, payload: {} } },
  { name: "EDIT_STORY whose id cannot be stringified", op: { type: "EDIT_STORY", payload: { id: { toString: null } } } },
  { name: "ADD_STORY whose epicId cannot be stringified", op: { type: "ADD_STORY", payload: { id: "s", title: "t", points: 1, epicId: { toString: null } } } },
];

for (const { name, op } of MALFORMED) {
  test(`applyOp rejects ${name} without throwing`, () => {
    const { db, room } = freshRoom();
    const result = applyOp(db, room, /** @type {any} */ (op));
    assert.equal(result.ok, false);
    assert.equal(room.version, 0);
  });
}

test("applyOp rejects when the commit fails, leaving the room unchanged", () => {
  const { db, room } = freshRoom();
  const before = room.doc;
  db.close();
  const result = applyOp(db, room, { type: "SET_PLAN_TITLE", payload: { title: "x" } });
  assert.equal(result.ok, false);
  assert.equal(room.version, 0);
  assert.equal(room.doc, before);
});
