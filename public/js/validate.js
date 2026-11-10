// @ts-check
/**
 * Pure field validators for the editors. The editor gates Save on these; the
 * reducer trusts validated payloads (same boundary as Brief 1).
 */

import { daysInMonth } from "./date.js";

/**
 * The single points rule: positive integer (>= 1). The one authority both the
 * editor coercer (parsePoints) and the load-boundary validator (validatePlan)
 * consume, so a drifting second threshold can't exist.
 * @param {unknown} n
 * @returns {boolean}
 */
export function isValidPoints(n) {
  return Number.isInteger(n) && /** @type {number} */ (n) >= 1;
}

/**
 * Coerce editor input to a valid points value, or null if invalid. Points are
 * positive integers (>= 1): rejects 0, negatives, non-integers and empties.
 * @param {unknown} input
 * @returns {number | null}
 */
export function parsePoints(input) {
  if (typeof input === "string" && input.trim() === "") return null;
  const n = Number(input);
  return isValidPoints(n) ? n : null;
}

/** @param {unknown} v @returns {boolean} a real calendar date as YYYY-MM-DD */
export function isISODate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** The velocity rule shared by the settings input and the plan contract. */
export const MAX_VELOCITY = Number.MAX_SAFE_INTEGER;

/**
 * Coerce settings-strip input to a velocity: rounded, at least 1, or null when
 * not a number or beyond MAX_VELOCITY.
 * @param {unknown} input
 * @returns {number | null}
 */
export function parseVelocity(input) {
  if (typeof input === "string" && input.trim() === "") return null;
  const n = Math.max(1, Math.round(Number(input)));
  return Number.isFinite(n) && n <= MAX_VELOCITY ? n : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonEmptyTitle(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalise an edited plan title to a single line: collapse every run of
 * whitespace — including the newlines a contenteditable inserts on Enter or a
 * multi-line paste — to one space, then trim. The band renders the title on one
 * line, so the stored value is kept one line too. Pure; the DOM handler calls
 * this before dispatching setPlanTitle.
 * @param {string} raw
 * @returns {string}
 */
export function singleLineTitle(raw) {
  return String(raw).replace(/\s+/g, " ").trim();
}
