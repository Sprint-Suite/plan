// @ts-check
/**
 * Plan-level persistence-boundary operations: envelope extraction, schema
 * migration and export, plus the document contract (plan-contract.js)
 * re-exported as validatePlan. Every load path passes through these, so a
 * foreign file or a malformed plan fails here, never in the renderer. Pure and
 * DOM-free; the Blob/file glue in main.js is thin wiring over this core.
 *
 * Failable functions return a discriminated result: { ok: true, plan } or
 * { ok: false, reason } with a human-readable reason naming the first failure.
 */

import { SCHEMA_VERSION as CURRENT_SCHEMA } from "./plan-contract.js";

export { validatePlan } from "./plan-contract.js";

/** @param {any} v @returns {boolean} a plain (non-array) object */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Version-dispatch migration seam (Brief 5 R4): walk a plan up one version at a
 * time via MIGRATORS until it reaches CURRENT_SCHEMA. migrators[1] = v1->v2 (deps)
 * and migrators[2] = v2->v3 (stretch) run for older saves. A missing/invalid
 * version, or one NEWER than this build, fails clearly — it never silently loads.
 * @param {any} plan
 * @returns {{ ok: true, plan: any } | { ok: false, reason: string }}
 */
export function migratePlan(plan) {
  const v = plan && plan.meta ? plan.meta.schemaVersion : undefined;
  if (!Number.isInteger(v) || v < 1) return { ok: false, reason: "missing or invalid schema version" };
  if (v > CURRENT_SCHEMA) return { ok: false, reason: "saved by a newer version of sprintplan" };
  let migrated = plan;
  for (let from = v; from < CURRENT_SCHEMA; from++) migrated = MIGRATORS[from](migrated);
  return { ok: true, plan: migrated };
}

/**
 * Version-keyed migrators: migrators[n] upgrades a v(n) plan to v(n+1). Additive
 * only, never deletes. v1->v2 (Brief 7) backfills the empty deps field; v2->v3
 * (phase2-build6) is a version bump only — `stretch` is optional and absent reads
 * as false, so there is no per-story backfill. Each stamps the new version so a
 * re-export carries it.
 */
const MIGRATORS = /** @type {Record<number, (plan: any) => any>} */ ({
  1: (plan) => ({ ...plan, deps: [], meta: { ...plan.meta, schemaVersion: 2 } }),
  2: (plan) => ({ ...plan, meta: { ...plan.meta, schemaVersion: 3 } }),
});

/**
 * Build the self-identifying FILE payload (R2): a wrapper that lets a foreign or
 * wrong-app file fail import with a clear "not a sprintplan board". Pure — the
 * caller supplies exportedAt (a boundary clock read), so this stays clock-free.
 * The inner plan's transient lastReturnedStoryIds is reset to [] (R6).
 * @param {any} state
 * @param {string} exportedAt ISO string stamped by the caller at export time
 */
export function exportPlan(state, exportedAt) {
  const plan = { ...state, lastReturnedStoryIds: [] };
  return { app: "sprintplan", schemaVersion: state.meta.schemaVersion, exportedAt, plan };
}

/**
 * Unwrap the inner plan from whichever envelope it arrives in, with leniency by
 * source (the load-bearing safety split, R2/R7): strict on uploaded FILES
 * (require the app header), lenient on our own RESTORE bytes (accept the
 * { savedAt, plan } envelope OR a legacy bare state).
 * @param {any} parsed
 * @param {"file" | "restore"} mode
 * @returns {{ ok: true, plan: any } | { ok: false, reason: string }}
 */
export function extractPlan(parsed, mode) {
  if (!isObject(parsed)) return { ok: false, reason: "file is not a plan object" };
  if (mode === "file") {
    // Strict: the user supplied these bytes, so demand the self-identifying header.
    if (parsed.app !== "sprintplan") return { ok: false, reason: "not a sprintplan board" };
    return { ok: true, plan: parsed.plan };
  }
  // restore: we wrote these bytes. Accept the { savedAt, plan } envelope OR a
  // legacy bare state (pre-Brief-5 autosave). Discarding a valid legacy board
  // would itself be the data loss this brief exists to prevent.
  if ("savedAt" in parsed && "plan" in parsed) return { ok: true, plan: parsed.plan };
  return { ok: true, plan: parsed };
}
