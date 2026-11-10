// @ts-check
/**
 * bin/audit-rooms.mjs: read-only pre-deploy audit of stored rooms against the
 * current document contract. Exit 0 only when every room loads cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, createRoom } from "../server/db.js";
import { createInitialState, reduce } from "../public/js/store.js";

function withStory() {
  return reduce(createInitialState("2026-07-06"), {
    type: "ADD_STORY", payload: { id: "s1", title: "Secret title", summary: "", points: 2, epicId: null },
  });
}

/** @param {(db: any) => void} seed */
function audit(seed) {
  const dir = mkdtempSync(join(tmpdir(), "audit-rooms-"));
  const path = join(dir, "rooms.db");
  const db = openDb(path);
  seed(db);
  db.close();
  const run = spawnSync(process.execPath, ["bin/audit-rooms.mjs", path], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return run;
}

const seedRoom = (/** @type {any} */ db, /** @type {string} */ id, /** @type {any} */ doc) =>
  createRoom(db, { id, companyId: "acme", shareToken: "t", mode: "open-link", doc });

test("classifies current, migratable and invalid rooms; exits 1 when any is invalid", () => {
  const run = audit((db) => {
    seedRoom(db, "room-current", withStory());
    seedRoom(db, "room-legacy", { ...withStory(), meta: { title: null, schemaVersion: 2 } });
    seedRoom(db, "room-orphan", { ...withStory(), backlog: [] });
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /room-current\s+valid/);
  assert.match(run.stdout, /room-legacy\s+migrates/);
  assert.match(run.stdout, /room-orphan\s+INVALID: a story is not placed on the board/);
  assert.doesNotMatch(run.stdout, /Secret title/, "never prints document content");
});

test("exits 0 when every room is valid or migratable", () => {
  const run = audit((db) => {
    seedRoom(db, "room-current", withStory());
    seedRoom(db, "room-legacy", { ...withStory(), meta: { title: null, schemaVersion: 2 } });
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("exits 1 on a missing database rather than creating one", () => {
  const run = spawnSync(process.execPath, ["bin/audit-rooms.mjs", "/nonexistent/rooms.db"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
});
