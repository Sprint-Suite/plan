// @ts-check
/**
 * Phase 2 spike — durable room store (better-sqlite3). Models retro's discipline:
 * the meta/schema_version migration idiom (ensureSchema on startup) and a
 * per-mutation transactional commit. One validated plan document per room as a
 * single row (PROPOSE §3) — plan already owns the validated serialisation
 * (exportPlan) and guard (validatePlan), so no normalised tables and no op-log.
 */

import Database from "better-sqlite3";
import { migratePlan } from "../public/js/plan-io.js";

const nowIso = () => new Date().toISOString();

/**
 * Open (or create) the room db and bring its schema up to date.
 * @param {string} path file path, or ":memory:"
 */
export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  return db;
}

/** Retro's idiom: meta.schema_version drives idempotent, versioned steps. v1 only today. */
function ensureSchema(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const v = row ? Number(row.value) : 0;
  if (v < 1) {
    db.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      share_token TEXT NOT NULL,
      mode        TEXT NOT NULL,
      plan_json   TEXT NOT NULL,
      version     INTEGER NOT NULL,
      updated_at  TEXT NOT NULL
    )`);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }
}

/**
 * Seed a room at version 0. INSERT OR REPLACE so re-seeding in a test is clean.
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, companyId: string, shareToken: string, mode: string, doc: any }} room
 */
export function createRoom(db, { id, companyId, shareToken, mode, doc }) {
  db.prepare(`INSERT OR REPLACE INTO rooms (id, company_id, share_token, mode, plan_json, version, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(id, companyId, shareToken, mode, JSON.stringify(doc), nowIso());
}

/**
 * A room's access metadata only, without reading or parsing its document, for
 * authorizing a join before anything heavier happens.
 * @returns {{ id: string, companyId: string, shareToken: string, mode: string } | null}
 */
export function loadRoomMeta(db, id) {
  const r = /** @type {any} */ (db.prepare("SELECT id, company_id, share_token, mode FROM rooms WHERE id = ?").get(id));
  return r ? { id: r.id, companyId: r.company_id, shareToken: r.share_token, mode: r.mode } : null;
}

/**
 * Re-hydrate a room (and its document + version) from the row. The document is
 * migrated to the current schema here; the upgraded form is persisted by the
 * room's next commit. Throws if the stored document cannot be migrated.
 * @returns {{ id: string, companyId: string, shareToken: string, mode: string, doc: any, version: number } | null}
 */
export function loadRoom(db, id) {
  const r = /** @type {any} */ (db.prepare("SELECT * FROM rooms WHERE id = ?").get(id));
  if (!r) return null;
  const migrated = migratePlan(JSON.parse(r.plan_json));
  if (!migrated.ok) throw new Error(`room ${id}: ${migrated.reason}`);
  return {
    id: r.id,
    companyId: r.company_id,
    shareToken: r.share_token,
    mode: r.mode,
    doc: migrated.plan,
    version: r.version,
  };
}

/**
 * Commit a newly-applied document + version transactionally. Retro's discipline:
 * this returns only after the write is durable, and the op loop calls it BEFORE
 * acking/broadcasting (rooms.js).
 * @param {import("better-sqlite3").Database} db
 */
export function commitRoom(db, id, doc, version) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE rooms SET plan_json = ?, version = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(doc), version, nowIso(), id);
  });
  tx();
}
