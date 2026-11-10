#!/usr/bin/env node
// @ts-check
// Read-only pre-deploy audit: checks every stored room against the current
// document contract. Prints one line per room (id + verdict, never content).
// Exit 0 when every room is valid or migrates cleanly; 1 otherwise.
//
// Usage: node bin/audit-rooms.mjs [/var/www/plan/data/rooms.db]
import Database from "better-sqlite3";
import { migratePlan, validatePlan } from "../public/js/plan-io.js";

/** @param {string} json @returns {string} "valid" | "migrates" | "INVALID: <reason>" */
function verdict(json) {
  let doc;
  try { doc = JSON.parse(json); } catch { return "INVALID: stored document is not JSON"; }
  const m = migratePlan(doc);
  if (!m.ok) return `INVALID: ${m.reason}`;
  const v = validatePlan(m.plan);
  if (!v.ok) return `INVALID: ${v.reason}`;
  return m.plan === doc ? "valid" : "migrates";
}

const path = process.argv[2] ?? "/var/www/plan/data/rooms.db";
let db;
try {
  db = new Database(path, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`cannot open ${path}: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}

const rows = /** @type {{ id: string, plan_json: string }[]} */ (db.prepare("SELECT id, plan_json FROM rooms ORDER BY id").all());
let invalid = 0;
for (const { id, plan_json } of rows) {
  const v = verdict(plan_json);
  if (v.startsWith("INVALID")) invalid++;
  console.log(`${id}  ${v}`);
}
db.close();
console.log(`${rows.length} rooms, ${invalid} invalid`);
process.exit(invalid ? 1 : 0);
