// @ts-check
/**
 * Productionise slice 1 — the room store (client sync layer).
 *
 * createRoomStore returns the SAME { getState, dispatch, subscribe } shape as
 * createStore, so every view module reuses it unchanged (R2). The model is
 * server-authoritative and PESSIMISTIC (R1): a local dispatch SENDS an op and
 * waits; the store mutates only when the server broadcasts the applied op back.
 * That removes optimistic-apply-then-rollback entirely — there is no client-side
 * divergence to reconcile.
 *
 * The transport is injected so the sync logic is unit-testable without a socket;
 * wsTransport wraps the browser WebSocket for the real app.
 *
 * @typedef {{
 *   send: (msg: any) => void,
 *   onMessage: (cb: (msg: any) => void) => void,
 *   onOpen: (cb: () => void) => void,
 *   onClose: (cb: () => void) => void,
 *   close: () => void,
 * }} Transport
 */

import { reduce, createInitialState } from "./store.js";
import { newId } from "./ids.js";

/**
 * After the connection drops the store is inert: nothing more is sent, and
 * onDisconnect fires once so the view can block the now-stale board.
 * @param {{ transport: Transport, name?: string, onNack?: (reason: string) => void, onPresence?: (participants: any[]) => void, onCursor?: (msg: { id: string, x?: number, y?: number, gone?: boolean }) => void, onDisconnect?: () => void }} opts
 * @returns {{ getState: () => any, dispatch: (action: { type: string, payload?: any }) => void, sendCursor: (x: number, y: number) => void, clearCursor: () => void, subscribe: (fn: (s: any) => void) => () => void, close: () => void }}
 */
export function createRoomStore({ transport, name = "guest", onNack = () => {}, onPresence = () => {}, onCursor = () => {}, onDisconnect = () => {} }) {
  let closed = false;
  const send = (/** @type {any} */ msg) => { if (!closed) transport.send(msg); };
  transport.onClose(() => {
    if (closed) return;
    closed = true;
    onDisconnect();
  });
  // Placeholder until the server's authoritative 'state' frame arrives.
  let state = createInitialState("2026-01-01");
  let version = 0;
  /** @type {Set<(s: any) => void>} */
  const subscribers = new Set();
  const notify = () => { for (const fn of subscribers) fn(state); };

  transport.onMessage((msg) => {
    if (msg.type === "state") {
      state = msg.doc;
      version = msg.version;
      notify();
    } else if (msg.type === "op") {
      // Authoritative: apply exactly what the server confirmed, in its order.
      state = reduce(state, msg.op);
      version = msg.version;
      notify();
    } else if (msg.type === "nack") {
      onNack(msg.reason);
    } else if (msg.type === "presence") {
      // Side-channel: presence never touches plan state/version (MP5 R2).
      onPresence(msg.participants);
    } else if (msg.type === "cursor") {
      // Ephemeral side-channel (phase2-build5, R1): a remote pointer position or
      // its removal. NEVER reduces, NEVER touches state/version — straight to the
      // view's cursor handler. The server has already excluded our own cursor.
      onCursor(msg);
    }
  });

  return {
    getState: () => state,
    dispatch(action) {
      // EDIT_STORY is sent as a field-DELTA (MP3): only the fields that differ
      // from this client's current view of the story, so concurrent edits to
      // different fields merge server-side instead of clobbering. Every other
      // action is sent whole.
      let payload = action.payload;
      const cur = action.type === "EDIT_STORY" ? state.stories?.[payload?.id] : null;
      if (cur) {
        const c = /** @type {any} */ (cur);
        const p = /** @type {any} */ (payload);
        const delta = /** @type {any} */ ({ id: p.id });
        for (const f of ["title", "summary", "points", "epicId"]) {
          if (p[f] !== c[f]) delta[f] = p[f];
        }
        payload = delta;
      }
      // Pessimistic: emit the op, do NOT reduce locally (R1).
      send({ type: "op", opId: newId("op"), op: { type: action.type, payload }, baseVersion: version });
    },
    /**
     * Send THIS client's pointer position as normalised board fractions (phase2-
     * build5). Pure ephemeral side-channel, parallel to dispatch: it goes over the
     * transport and NEVER through the op loop — the server relays it without
     * touching room state. Fire-and-forget.
     * @param {number} x @param {number} y
     */
    sendCursor(x, y) {
      send({ type: "cursor", x, y });
    },
    /** Tell the room this client's cursor has left the board (phase2-build5). */
    clearCursor() {
      send({ type: "cursor", gone: true });
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Tear down the connection (navigation / leaving a room). */
    close() {
      transport.close();
    },
  };
}

/**
 * Browser WebSocket transport. Browser-only glue (verified in the real app, not
 * the unit net). Frames are JSON {type, ...}.
 * @param {string} url
 * @returns {Transport}
 */
export function wsTransport(url) {
  const ws = new WebSocket(url);
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    onMessage: (cb) => ws.addEventListener("message", (e) => cb(JSON.parse(/** @type {MessageEvent} */ (e).data))),
    onOpen: (cb) => ws.addEventListener("open", cb),
    onClose: (cb) => ws.addEventListener("close", cb),
    close: () => ws.close(),
  };
}
