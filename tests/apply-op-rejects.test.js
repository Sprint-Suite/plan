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
  const result = applyOp(db, room, { type: "SET_PLAN_TITLE", payload: "x" });
  assert.equal(result.ok, false);
  assert.equal(room.version, 0);
  assert.equal(room.doc, before);
});

test("applyOp rejects an op whose payload cannot be serialised for broadcast, before committing", () => {
  const { db, room } = freshRoom();
  /** @type {any} */
  let extra = "x";
  for (let i = 0; i < 10000; i++) extra = [extra];
  const result = applyOp(db, room, { type: "ADD_EPIC", payload: { id: "e", title: "invisible", extra } });
  assert.equal(result.ok, false);
  assert.equal(room.version, 0);
  assert.equal(/** @type {any} */ (loadRoom(db, "r")).version, 0);
});

/** A room holding epic E1 with story a, plus an unparented story d. */
function populatedRoom() {
  const { db, room } = freshRoom();
  for (const op of [
    { type: "ADD_EPIC", payload: { id: "E1", title: "One" } },
    { type: "ADD_STORY", payload: { id: "a", title: "A", summary: "", points: 3, epicId: "E1" } },
    { type: "ADD_STORY", payload: { id: "d", title: "D", summary: "", points: 2, epicId: null } },
  ]) assert.equal(applyOp(db, room, op).ok, true);
  return { db, room };
}

const MISSHAPEN_COMMANDS = [
  { name: "ADD_EPIC reusing an existing epic id", op: { type: "ADD_EPIC", payload: { id: "E1", title: "Replaced" } } },
  { name: "ADD_EPIC with a non-string id", op: { type: "ADD_EPIC", payload: { id: 7, title: "Seven" } } },
  { name: "MOVE_STORY with an unknown target kind", op: { type: "MOVE_STORY", payload: { storyId: "d", target: { kind: "typo", index: 0 }, beforeId: null } } },
  { name: "MOVE_STORY with a fractional sprint index", op: { type: "MOVE_STORY", payload: { storyId: "d", target: { kind: "sprint", index: 0.5 }, beforeId: null } } },
  { name: "MOVE_STORY with an out-of-range sprint index", op: { type: "MOVE_STORY", payload: { storyId: "d", target: { kind: "sprint", index: 99 }, beforeId: null } } },
  { name: "DELETE_EPIC with no mode", op: { type: "DELETE_EPIC", payload: { id: "E1" } } },
  { name: "DELETE_EPIC with an unknown mode", op: { type: "DELETE_EPIC", payload: { id: "E1", mode: "typo" } } },
  { name: "DELETE_EPIC with a null id (would delete every unparented story)", op: { type: "DELETE_EPIC", payload: { id: null, mode: "delete" } } },
];

for (const { name, op } of MISSHAPEN_COMMANDS) {
  test(`applyOp rejects ${name}, leaving the room untouched`, () => {
    const { db, room } = populatedRoom();
    const before = structuredClone(room.doc);
    const version = room.version;
    const result = applyOp(db, room, /** @type {any} */ (op));
    assert.equal(result.ok, false);
    assert.equal(room.version, version);
    assert.deepEqual(room.doc, before);
    assert.equal(/** @type {any} */ (loadRoom(db, "r")).version, version);
  });
}

test("DELETE_EPIC on an unknown string id stays a harmless no-op", () => {
  const { db, room } = populatedRoom();
  const result = applyOp(db, room, { type: "DELETE_EPIC", payload: { id: "nope", mode: "delete" } });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(room.doc.stories).sort(), ["a", "d"]);
});
