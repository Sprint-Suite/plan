// @ts-check
/**
 * Phase 2 spike — the authoritative op loop (PROPOSE §7, the load-bearing seam).
 *
 * The whole conflict model lives in applyOp:
 *   1. allow-list the op TYPE (11 wire ops; excluded types never reach reduce),
 *   2. version-gate EDIT_STORY (reject if written against a stale version),
 *   3. apply via plan's EXISTING pure reducer (imported, never re-implemented),
 *   4. guard with plan's EXISTING validatePlan,
 *   5. commit transactionally BEFORE the caller acks/broadcasts.
 *
 * Everything other than the EDIT_STORY gate converges under arrival order +
 * validatePlan; that is the entire net-new rule the spike adds.
 */

import { reduce } from "../public/js/store.js";
import { validatePlan } from "../public/js/plan-io.js";
import { commitRoom } from "./db.js";

/**
 * The 11 wire ops. All serialise safely under arrival order + validatePlan; EDIT_STORY
 * is a field-delta merged against the latest story (MP3), so it needs no version gate.
 */
const ALLOWED = new Set([
  "ADD_EPIC", "EDIT_EPIC", "DELETE_EPIC",
  "ADD_STORY", "EDIT_STORY", "DELETE_STORY", "MOVE_STORY",
  "LINK_DEP", "UNLINK_DEP",
  // phase2-build4 #10: the room name IS the plan title, edited live in a room.
  "SET_PLAN_TITLE",
  // phase2-build6: mark a story a stretch goal — a whole-payload data op that
  // records intent without touching capacity (the honesty invariant lives in the
  // selectors, not here).
  "SET_STORY_STRETCH",
]);

/** @typedef {{ ok: true, version: number, op: { type: string, payload: any } } | { ok: false, reason: string }} OpResult */

/**
 * Apply one op to the room's authoritative document, persisting before return.
 * Mutates `room.doc`/`room.version` on success; leaves them untouched on reject.
 *
 * EDIT_STORY is a field-delta (MP3): the client sends only the changed fields, and
 * we merge them onto the LATEST authoritative story before reduce, so concurrent
 * edits to DIFFERENT fields compose and same-field edits are last-write-wins. The
 * EFFECTIVE (merged) op is returned so the server broadcasts a complete payload —
 * the shipped reducer replaces all four story fields, so a bare delta would null
 * the untouched ones on every client.
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, doc: any, version: number }} room
 * @param {{ type: string, payload: any }} op
 * @returns {OpResult}
 */
export function applyOp(db, room, { type, payload }) {
  if (typeof type !== "string" || !ALLOWED.has(type)) {
    return { ok: false, reason: `op type not allowed: ${typeof type === "string" ? type : typeof type}` };
  }

  let effPayload = payload;
  let next;
  try {
    if (type === "EDIT_STORY") {
      const cur = room.doc.stories[payload?.id];
      effPayload = cur ? { ...cur, ...payload } : payload; // merge delta onto latest
    }
    next = reduce(room.doc, { type, payload: effPayload });
    const v = validatePlan(next);
    if (!v.ok) return { ok: false, reason: v.reason };
    // The caller broadcasts this op after commit; prove it serialises first, so
    // a commit can never be followed by a failed (invisible) broadcast.
    JSON.stringify(effPayload);
  } catch {
    return { ok: false, reason: "invalid op" };
  }

  const newVersion = room.version + 1;
  try {
    commitRoom(db, room.id, next, newVersion); // durable BEFORE ack/broadcast
  } catch (e) {
    console.error(`commit failed for room ${room.id}:`, e);
    return { ok: false, reason: "could not save the change" };
  }
  room.doc = next;
  room.version = newVersion;
  return { ok: true, version: newVersion, op: { type, payload: effPayload } };
}
