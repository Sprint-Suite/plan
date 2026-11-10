// @ts-check
// Child-process rooms server for crash-survival tests: a crash must not take
// the test runner down with it. Prints the bound port on stdout.
import { openDb, createRoom } from "../../server/db.js";
import { startSpikeServer } from "../../server/server.js";

const db = openDb(":memory:");
// A room whose stored document is corrupt, so loading it throws during upgrade.
createRoom(db, { id: "corrupt", companyId: "acme", shareToken: "t", mode: "open-link", doc: {} });
db.prepare("UPDATE rooms SET plan_json = '{' WHERE id = 'corrupt'").run();

// Anonymous, but slow, so a client can fail its socket while auth is pending.
const slowAnonAuth = {
  mode: "stub",
  verifySession: () => new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  requireAuth: (/** @type {any} */ _req, /** @type {any} */ res) => res.status(401).end(),
  companyOf: () => null,
  mountRoutes: () => {},
};

const server = await startSpikeServer({
  db,
  auth: slowAnonAuth,
  seedRoom: { id: "r", companyId: "acme", shareToken: "t", mode: "open-link" },
});
console.log(`PORT=${new URL(server.httpUrl).port}`);
