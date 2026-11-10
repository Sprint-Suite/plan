// @ts-check
/**
 * The rooms service's in-memory state: one authoritative document per active
 * room, the sockets in it, and connection accounting. A room is cached only
 * while it has an admitted socket and is evicted on the last leave, so failed
 * or rejected joins never populate the cache. Every outbound frame goes through
 * send(), which cuts off a socket whose backlog exceeds maxBufferedBytes.
 */

import { WebSocket } from "ws";
import { loadRoom } from "./db.js";

/**
 * @param {{ db: import("better-sqlite3").Database, limits: typeof import("./limits.js").LIMITS }} opts
 */
export function createRoomHub({ db, limits }) {
  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, Set<WebSocket>>} */
  const sockets = new Map();
  /** @type {Map<string, number>} admissions reserved but not yet attached */
  const reserved = new Map();
  let total = 0;

  const inRoom = (/** @type {string} */ id) => (sockets.get(id)?.size ?? 0) + (reserved.get(id) ?? 0);
  const evictIfEmpty = (/** @type {string} */ id) => {
    if (inRoom(id) > 0) return;
    sockets.delete(id);
    rooms.delete(id);
  };
  const bump = (/** @type {string} */ id, /** @type {number} */ d) => {
    const n = (reserved.get(id) ?? 0) + d;
    if (n > 0) reserved.set(id, n);
    else reserved.delete(id);
  };

  /** False (and the socket cut off) when it is closed or its backlog is over the limit. */
  const writable = (/** @type {WebSocket} */ ws) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount <= limits.maxBufferedBytes) return true;
    ws.terminate();
    return false;
  };
  const sendRaw = (/** @type {WebSocket} */ ws, /** @type {string} */ json) => { if (writable(ws)) ws.send(json); };

  return {
    /** @param {WebSocket} ws @param {any} msg */
    send: (ws, msg) => sendRaw(ws, JSON.stringify(msg)),

    /** Answer a ping, echoing its payload, under the same backlog guard. */
    pong: (/** @type {WebSocket} */ ws, /** @type {Buffer} */ data) => { if (writable(ws)) ws.pong(data); },

    /** Fan out to the room, optionally skipping one socket. */
    broadcast(/** @type {string} */ id, /** @type {any} */ msg, /** @type {WebSocket | null} */ except = null) {
      const json = JSON.stringify(msg);
      for (const ws of sockets.get(id) ?? []) if (ws !== except) sendRaw(ws, json);
    },

    /** Reserve a connection slot; false when the room or the service is full. */
    reserve(/** @type {string} */ id) {
      if (total >= limits.maxTotalSockets || inRoom(id) >= limits.maxRoomSockets) return false;
      total++;
      bump(id, 1);
      return true;
    },

    /** Give back a reservation whose handshake never completed. */
    release(/** @type {string} */ id) {
      total--;
      bump(id, -1);
      evictIfEmpty(id);
    },

    /**
     * Turn a reservation into an admitted socket and return the room's single
     * authoritative object (cached, or loaded now and cached). Throws, with the
     * reservation still held, if the stored room cannot be loaded.
     * @param {string} id @param {WebSocket} ws
     */
    attach(id, ws) {
      if (!rooms.has(id)) rooms.set(id, loadRoom(db, id));
      bump(id, -1);
      if (!sockets.has(id)) sockets.set(id, new Set());
      /** @type {Set<WebSocket>} */ (sockets.get(id)).add(ws);
      return rooms.get(id);
    },

    /** Remove an admitted socket; evict the room when it was the last one. */
    detach(/** @type {string} */ id, /** @type {WebSocket} */ ws) {
      const set = sockets.get(id);
      if (!set?.delete(ws)) return;
      total--;
      evictIfEmpty(id);
    },

    /** The admitted sockets in a room (for presence and colour assignment). */
    members: (/** @type {string} */ id) => [...(sockets.get(id) ?? [])],

    cacheSize: () => rooms.size,
    socketCount: (/** @type {string} */ id) => sockets.get(id)?.size ?? 0,
  };
}
