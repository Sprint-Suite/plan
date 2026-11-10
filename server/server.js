// @ts-check
/**
 * The rooms service: an express app (auth routes, POST /rooms) plus a ws server.
 *   - A ws upgrade is rate limited, authorized against the room's metadata and
 *     blend policy (decideUpgrade), then admitted into a capacity slot.
 *   - Each active room has ONE authoritative document (room-hub.js); every op
 *     runs through applyOp (reduce -> validatePlan -> commit BEFORE broadcast).
 *   - Limits (limits.js) bound frames, documents, rates and connections.
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";

import { loadRoom, loadRoomMeta, createRoom } from "./db.js";
import { makeSecurityHeaders } from "./middleware/securityHeaders.js";
import { applyOp } from "./rooms.js";
import { createAuthProvider } from "./auth.js";
import { LIMITS, createTokenBucket, createWindowLimiter } from "./limits.js";
import { createRoomHub } from "./room-hub.js";
import { createInitialState } from "../public/js/store.js";
import { validatePlan, migratePlan } from "../public/js/plan-io.js";
import { newId } from "../public/js/ids.js";
import { PALETTE, paletteColour, pickColourIndex } from "../public/js/cursors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Decide a ws upgrade against the room's blend policy (poker's decideUpgrade shape).
 * @returns {{ ok: true, identity: "verified" | "claimed" } | { ok: false, code: number, msg: string }}
 */
export function decideUpgrade(room, session, token) {
  if (!room) return { ok: false, code: 404, msg: "No Room" };

  if (room.mode === "company-only") {
    if (!session) return { ok: false, code: 401, msg: "No Session" };
    // Company scope: a valid session for a DIFFERENT company is a cross-company
    // attempt — refuse, never leak.
    if (session.company !== room.companyId) return { ok: false, code: 403, msg: "Wrong Company" };
    return { ok: true, identity: "verified" };
  }

  // open-link: link-possession is the gate; identity is self-asserted.
  if (token !== room.shareToken) return { ok: false, code: 403, msg: "Bad Token" };
  const identity = session && session.company === room.companyId ? "verified" : "claimed";
  return { ok: true, identity };
}


/** Reject a raw upgrade socket with an HTTP status line. */
function refuse(/** @type {any} */ socket, /** @type {number} */ code, /** @type {string} */ msg) {
  socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
  socket.destroy();
}

/** The starting document for a new room: an imported plan (migrated, validated) or a blank board. */
function initialDoc(/** @type {any} */ plan) {
  if (plan == null) return { ok: true, plan: createInitialState("2026-01-05") };
  const m = migratePlan(plan);
  const v = m.ok ? validatePlan(m.plan) : m;
  return v.ok ? { ok: true, plan: { ...v.plan, lastReturnedStoryIds: [] } } : v;
}

/**
 * POST /rooms — authed room creation. A room's company is the creator's session
 * company, never a client value. The body is parsed only after authentication.
 * @param {any} app @param {{ db: any, provider: any, limits: typeof LIMITS, now: () => number }} deps
 */
function mountCreateRoom(app, { db, provider, limits, now }) {
  const perUser = createWindowLimiter({ max: limits.roomsPerUserPerHour, windowMs: 60 * 60 * 1000, now });
  app.post("/rooms", provider.requireAuth, express.json({ limit: limits.maxCreateBodyBytes }), (/** @type {any} */ req, /** @type {any} */ res) => {
    const companyId = provider.companyOf(req);
    const userId = provider.userOf(req);
    if (!companyId || !userId) return res.status(403).json({ error: "no company on session" });
    const mode = req.body?.mode === "open-link" ? "open-link" : "company-only";
    const doc = initialDoc(req.body?.plan);
    if (!doc.ok) return res.status(400).json({ error: doc.reason });
    if (Buffer.byteLength(JSON.stringify(doc.plan), "utf8") > limits.maxDocBytes) {
      return res.status(413).json({ error: "the plan is too large" });
    }
    if (!perUser.allow(userId)) return res.status(429).json({ error: "too many rooms created; try again later" });
    const id = `${companyId}-${newId("room")}`;
    const shareToken = newId("share");
    createRoom(db, { id, companyId, shareToken, mode, doc: doc.plan });
    res.json({ id, companyId, shareToken, mode });
  });
}

/**
 * Start the server. Each instance holds its own hub, so tests are isolated.
 * `limits` overrides individual LIMITS; `now` is the clock for every limiter.
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   port?: number,
 *   serveStatic?: boolean,
 *   seedRoom?: { id: string, companyId: string, shareToken: string, mode: string } | null,
 *   auth?: any,
 *   host?: string,
 *   limits?: Partial<typeof LIMITS>,
 *   now?: () => number,
 * }} opts
 */
export async function startSpikeServer({ db, port = 0, serveStatic = false, seedRoom = null, auth = null, host = "127.0.0.1", limits: overrides = {}, now = Date.now }) {
  const provider = auth ?? (await createAuthProvider(process.env));
  const limits = { ...LIMITS, ...overrides };
  if (seedRoom && !loadRoom(db, seedRoom.id)) {
    createRoom(db, { ...seedRoom, doc: createInitialState("2026-01-05") });
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(makeSecurityHeaders()); // first, so headers cover every response
  app.get("/health", (/** @type {any} */ _req, /** @type {any} */ res) => res.json({ ok: true }));
  provider.mountRoutes(app);
  mountCreateRoom(app, { db, provider, limits, now });
  if (serveStatic) app.use(express.static(pathJoin(__dirname, "..", "public")));

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes });
  const hub = createRoomHub({ db, limits });
  const ctx = { db, provider, limits, now, hub, wss };
  attachUpgrades(httpServer, ctx);

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (httpServer.address());
      const reachHost = host === "0.0.0.0" ? "localhost" : host;
      resolve({
        url: `ws://${reachHost}:${addr.port}`,
        httpUrl: `http://${reachHost}:${addr.port}`,
        close: () => { wss.close(); httpServer.close(); httpServer.closeAllConnections(); },
        cacheSize: hub.cacheSize,
        socketCount: hub.socketCount,
      });
    });
  });
}

/**
 * The upgrade path, cheapest checks first: a process-wide rate bucket and the
 * pending ceiling (no db/auth work), then metadata-only authorization, then a
 * capacity reservation, and only then the handshake and the room document.
 * @param {import("node:http").Server} httpServer @param {any} ctx
 */
function attachUpgrades(httpServer, ctx) {
  const { db, provider, limits, now } = ctx;
  const bucket = createTokenBucket({ rate: limits.upgradeRate, burst: limits.upgradeBurst, now });
  let pending = 0;

  const authorize = async (/** @type {any} */ req) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const roomId = url.searchParams.get("room") ?? "";
      const name = (url.searchParams.get("name") ?? "").trim().slice(0, limits.maxNameLength) || "guest";
      const meta = loadRoomMeta(db, roomId);
      const session = await provider.verifySession(req.headers);
      return { roomId, name, session, decision: decideUpgrade(meta, session, url.searchParams.get("token")) };
    } finally {
      pending--;
    }
  };

  httpServer.on("upgrade", (req, socket, head) => {
    socket.on("error", (e) => console.error("upgrade socket error:", e.message));
    if (!bucket.take() || pending >= limits.maxPendingUpgrades) return refuse(socket, 503, "Busy");
    pending++;
    authorize(req)
      .then((a) => admit(ctx, a, req, socket, head))
      .catch((e) => { console.error("ws upgrade failed:", e); socket.destroy(); });
  });
}

/** Admit an authorized upgrade into a reserved slot and attach it to its room. */
function admit(/** @type {any} */ ctx, /** @type {any} */ a, /** @type {any} */ req, /** @type {any} */ socket, /** @type {any} */ head) {
  const { hub, wss } = ctx;
  if (!a.decision.ok) return refuse(socket, a.decision.code, a.decision.msg);
  if (socket.destroyed) return;
  if (!hub.reserve(a.roomId)) return refuse(socket, 503, "Room Full");
  let attached = false;
  socket.once("close", () => { if (!attached) hub.release(a.roomId); });
  wss.handleUpgrade(req, socket, head, (/** @type {any} */ ws) => {
    attached = true;
    let room;
    try {
      room = hub.attach(a.roomId, ws);
    } catch (e) {
      console.error(`room ${a.roomId} could not be loaded:`, e);
      hub.release(a.roomId);
      ws.terminate();
      return;
    }
    ws.meta = participantMeta(ctx, a, ws);
    onConnection(ctx, ws, room);
  });
}

/** Per-connection identity, colour and rate buckets. */
function participantMeta(/** @type {any} */ { hub, limits, now }, /** @type {any} */ a, /** @type {any} */ ws) {
  // The lowest palette index no other participant holds, so a leaver's colour
  // is reused first and two participants never collide below palette size.
  const used = hub.members(a.roomId).filter((/** @type {any} */ s) => s !== ws).map((/** @type {any} */ s) => s.meta.colourIndex);
  const colourIndex = pickColourIndex(used, PALETTE.length);
  return {
    roomId: a.roomId, identity: a.decision.identity, name: a.name, session: a.session, id: newId("p"),
    colourIndex, colour: paletteColour(colourIndex),
    opBucket: createTokenBucket({ rate: limits.opRate, burst: limits.opBurst, now }),
    cursorBucket: createTokenBucket({ rate: limits.cursorRate, burst: limits.cursorBurst, now }),
    cursorVisible: false,
  };
}

/** The room's participants, server-derived from its sockets; never plan state. */
function broadcastPresence(/** @type {any} */ hub, /** @type {string} */ roomId) {
  const participants = hub.members(roomId).map((/** @type {any} */ ws) => {
    const m = ws.meta;
    return { id: m.id, name: m.name, identity: m.identity, colour: m.colour };
  });
  hub.broadcast(roomId, { type: "presence", participants });
}

function onConnection(/** @type {any} */ ctx, /** @type {any} */ ws, /** @type {any} */ room) {
  const { hub } = ctx;
  const { roomId, identity } = ws.meta;
  hub.send(ws, { type: "state", doc: room.doc, version: room.version, identity });
  broadcastPresence(hub, roomId);
  ws.on("error", (/** @type {Error} */ e) => console.error("ws socket error:", e.message));
  ws.on("message", (/** @type {any} */ data) => {
    try {
      handleMessage(ctx, ws, room, data);
    } catch (e) {
      console.error("ws message handling failed:", e);
    }
  });
  ws.on("close", () => { hub.detach(roomId, ws); broadcastPresence(hub, roomId); });
}

/**
 * Ephemeral cursor relay to the OTHER sockets: never touches the document. The
 * frame is rebuilt from {id, x, y | gone}. Positions spend the cursor bucket; a
 * 'gone' is relayed only for a cursor that is currently visible, so repeated
 * 'gone' frames cannot flood the room.
 */
function relayCursor(/** @type {any} */ hub, /** @type {any} */ ws, /** @type {any} */ msg) {
  const m = ws.meta;
  if (msg.gone === true) {
    if (!m.cursorVisible) return;
    m.cursorVisible = false;
    hub.broadcast(m.roomId, { type: "cursor", id: m.id, gone: true }, ws);
    return;
  }
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !m.cursorBucket.take()) return;
  m.cursorVisible = true;
  hub.broadcast(m.roomId, { type: "cursor", id: m.id, x: msg.x, y: msg.y }, ws);
}

function handleMessage(/** @type {any} */ { db, hub, limits }, /** @type {any} */ ws, /** @type {any} */ room, /** @type {any} */ data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
  if (msg.type === "cursor") return relayCursor(hub, ws, msg);
  // opId is echoed in the ack/nack, so bound it before anything commits.
  if (msg.type !== "op" || typeof msg.opId !== "string" || msg.opId.length > 64) return;
  const nack = (/** @type {string} */ reason) => hub.send(ws, { type: "nack", opId: msg.opId, reason });
  if (!ws.meta.opBucket.take()) return nack("too many changes, slow down");

  const result = applyOp(db, room, { type: msg.op?.type, payload: msg.op?.payload }, limits);
  // The EFFECTIVE op is broadcast (the merged full payload for EDIT_STORY), so
  // every client reduces a complete payload.
  if (result.ok) hub.broadcast(ws.meta.roomId, { type: "op", opId: msg.opId, op: result.op, version: result.version });
  else nack(result.reason);
}
