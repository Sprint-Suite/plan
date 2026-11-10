// @ts-check
/**
 * The v3 plan document contract: the single load boundary for restore, file
 * import, room import and every server-applied op. Total — returns a reason for
 * any input instead of throwing — and uses own-property lookups only, so an
 * inherited key ("constructor", "toString") is never mistaken for an id.
 * Expects a migrated plan; migratePlan owns the version verdict.
 */

import { isValidPoints, isISODate, MAX_VELOCITY } from "./validate.js";
import { PALETTE } from "./epic-palette.js";
import { generateSprints } from "./plan-maths.js";

/** The schema version this build understands. */
export const SCHEMA_VERSION = 3;

/** @param {any} v */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** @param {any} v */
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** @param {any} v @param {number} lo @param {number} hi */
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** @param {object} obj @param {any} key */
const has = (obj, key) => typeof key === "string" && Object.hasOwn(obj, key);
/** A printable form of a possibly non-string id, for reasons. @param {any} v */
const label = (v) => (typeof v === "string" ? v : `(${typeof v})`);

/** @param {any} plan @returns {string | null} */
function checkShape(plan) {
  if (!isObject(plan)) return "plan is not an object";
  for (const key of ["meta", "settings", "epics", "stories"]) {
    if (!isObject(plan[key])) return `missing or invalid key: ${key}`;
  }
  for (const key of ["sprints", "backlog", "deps"]) {
    if (!Array.isArray(plan[key])) return `missing or invalid key: ${key}`;
  }
  if (plan.lastReturnedStoryIds !== undefined && !isStringArray(plan.lastReturnedStoryIds)) {
    return "invalid lastReturnedStoryIds";
  }
  return null;
}

/** @param {any} plan @returns {string | null} */
function checkMetaAndSettings({ meta, settings }) {
  if (meta.schemaVersion !== SCHEMA_VERSION) return "unexpected schema version";
  if (meta.title !== null && typeof meta.title !== "string") return "plan title must be text";
  if (!isISODate(settings.startDate)) return "invalid start date";
  if (!isIntIn(settings.durationMonths, 1, 3)) return "invalid plan duration";
  if (!isIntIn(settings.sprintWeeks, 1, 4)) return "invalid sprint length";
  if (!isIntIn(settings.velocity, 1, MAX_VELOCITY)) return "invalid velocity";
  if (!isIntIn(settings.bufferPct, 0, 99)) return "invalid buffer";
  return null;
}

const SPRINT_FACTS = ["index", "name", "startDate", "endDate", "days", "isPartial"];

/** Sprints are derived data: they must equal what the settings generate. */
function checkSprints(/** @type {any} */ { settings, sprints }) {
  const expected = generateSprints(settings);
  if (sprints.length !== expected.length) return "sprints do not match the plan settings";
  for (let i = 0; i < expected.length; i++) {
    const sp = sprints[i];
    if (!isObject(sp)) return `sprint ${i + 1} is invalid`;
    const e = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (expected[i]));
    if (SPRINT_FACTS.some((k) => sp[k] !== e[k])) return `sprint ${i + 1} does not match the plan settings`;
    if (!isStringArray(sp.placedStoryIds)) return `sprint ${i + 1} has invalid placedStoryIds`;
  }
  return null;
}

/** @param {any} plan @returns {string | null} */
function checkEpics({ epics }) {
  for (const key of Object.keys(epics)) {
    const e = epics[key];
    if (!isObject(e) || e.id !== key) return `epic "${key}" is invalid`;
    if (typeof e.title !== "string") return `epic "${key}" has an invalid title`;
    if (!PALETTE.includes(e.colourKey)) return `epic "${key}" has an invalid colour`;
  }
  return null;
}

/** @param {any} plan @returns {string | null} */
function checkStories({ stories, epics }) {
  for (const key of Object.keys(stories)) {
    const s = stories[key];
    if (!isObject(s) || s.id !== key) return `story "${key}" is invalid`;
    if (typeof s.title !== "string" || typeof s.summary !== "string") return `story "${key}" has invalid text`;
    if (!isValidPoints(s.points)) return `story "${key}" has invalid points`;
    if (s.epicId !== null && !has(epics, s.epicId)) return `story "${key}" references unknown epic "${label(s.epicId)}"`;
    if (s.stretch !== undefined && typeof s.stretch !== "boolean") return `story "${key}" has an invalid stretch flag`;
  }
  return null;
}

/** Every story sits in exactly one of backlog / a sprint, and nothing else does. */
function checkPlacement(/** @type {any} */ { stories, backlog, sprints }) {
  const seen = new Set();
  for (const ids of [backlog, ...sprints.map((/** @type {any} */ s) => s.placedStoryIds)]) {
    if (!isStringArray(ids)) return "placement lists must contain story ids";
    for (const id of ids) {
      if (!has(stories, id)) return `id "${id}" is not a known story`;
      if (seen.has(id)) return `id "${id}" appears in more than one place`;
      seen.add(id);
    }
  }
  if (seen.size !== Object.keys(stories).length) return "a story is not placed on the board";
  return null;
}

/** Directed pairs between two distinct stories; unique ids; no duplicate pair. */
function checkDeps(/** @type {any} */ { deps, stories }) {
  const ids = new Set();
  const pairs = new Set();
  for (const d of deps) {
    if (!isObject(d) || typeof d.id !== "string") return "a dependency is invalid";
    if (ids.has(d.id)) return `duplicate dependency id "${d.id}"`;
    for (const end of [d.blockerId, d.blockedId]) {
      if (!has(stories, end)) return `dependency "${d.id}" references unknown story "${label(end)}"`;
    }
    if (d.blockerId === d.blockedId) return `dependency "${d.id}" links a story to itself`;
    const pair = `${d.blockerId}>${d.blockedId}`;
    if (pairs.has(pair)) return `duplicate dependency between "${d.blockerId}" and "${d.blockedId}"`;
    ids.add(d.id);
    pairs.add(pair);
  }
  return null;
}

const CHECKS = [checkMetaAndSettings, checkSprints, checkEpics, checkStories, checkPlacement, checkDeps];

/**
 * @param {any} plan
 * @returns {{ ok: true, plan: any } | { ok: false, reason: string }}
 */
export function validatePlan(plan) {
  const shape = checkShape(plan);
  if (shape) return { ok: false, reason: shape };
  for (const check of CHECKS) {
    const reason = check(plan);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, plan };
}
