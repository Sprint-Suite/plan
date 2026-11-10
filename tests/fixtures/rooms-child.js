// @ts-check
// Child-process rooms server for crash-survival tests: a crash must not take
// the test runner down with it. Prints the bound port on stdout.
import { openDb, createRoom } from "../../server/db.js";
import { startSpikeServer } from "../../server/server.js";

const db = openDb(":memory:");
// A room whose stored document is corrupt, so loading it throws during upgrade.
createRoom(db, { id: "corrupt", companyId: "acme", shareToken: "t", mode: "open-link", doc: {} });
db.prepare("UPDATE rooms SET plan_json = '{' WHERE id = 'corrupt'").run();
const server = await startSpikeServer({
  db,
  seedRoom: { id: "r", companyId: "acme", shareToken: "t", mode: "open-link" },
});
console.log(`PORT=${new URL(server.httpUrl).port}`);
