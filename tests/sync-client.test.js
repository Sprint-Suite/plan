// @ts-check
/**
 * Productionise slice 1 — the room store (client sync layer). Server-authoritative,
 * pessimistic: a local dispatch SENDS an op and waits; the store changes only when
 * the server broadcasts. Driven here through an injected fake transport, so the
 * sync logic is proven without a real socket (the wsTransport glue is browser-
 * verified). Mirrors the createStore interface so the view reuses it unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduce, createInitialState } from "../public/js/store.js";
import { createRoomStore } from "../public/js/sync-client.js";

/** A transport double: records sent frames, lets the test push server frames in. */
function fakeTransport() {
  let onMessage = () => {};
  return {
    sent: /** @type {any[]} */ ([]),
    send(msg) { this.sent.push(msg); },
    onMessage(cb) { onMessage = cb; },
    onOpen() {},
    onClose(cb) { this.closeCb = cb; },
    close() {},
    receive(msg) { onMessage(msg); },
    drop() { this.closeCb?.(); },
  };
}

const addStory = (id) => ({ type: "ADD_STORY", payload: { id, title: id, summary: "", points: 3, epicId: null } });

/** A known authoritative doc with one story S1, at a chosen version. */
function stateFrame(version) {
  const doc = reduce(createInitialState("2026-01-05"), addStory("S1"));
  return { type: "state", doc, version };
}

test("interface mirrors createStore: getState / dispatch / subscribe", () => {
  const store = createRoomStore({ transport: fakeTransport() });
  assert.equal(typeof store.getState, "function");
  assert.equal(typeof store.dispatch, "function");
  assert.equal(typeof store.subscribe, "function");
  const off = store.subscribe(() => {});
  assert.equal(typeof off, "function", "subscribe returns an unsubscribe fn");
});

test("a 'state' frame sets the doc + version and notifies", () => {
  const t = fakeTransport();
  const store = createRoomStore({ transport: t });
  let notified = null;
  store.subscribe((s) => { notified = s; });

  t.receive(stateFrame(5));

  assert.ok("S1" in store.getState().stories);
  assert.equal(notified, store.getState());
});

test("dispatch SENDS one op with the current baseVersion and does NOT change local state (pessimistic)", () => {
  const t = fakeTransport();
  const store = createRoomStore({ transport: t });
  t.receive(stateFrame(5));
  const before = store.getState();

  store.dispatch(addStory("S2"));

  assert.equal(t.sent.length, 1);
  const op = t.sent[0];
  assert.equal(op.type, "op");
  assert.equal(op.op.type, "ADD_STORY");
  assert.equal(op.op.payload.id, "S2");
  assert.equal(op.baseVersion, 5);
  assert.ok(typeof op.opId === "string" && op.opId.length > 0, "carries a correlation opId");
  // pessimistic: local state untouched until the broadcast comes back
  assert.equal(store.getState(), before);
  assert.equal("S2" in store.getState().stories, false);
});

test("an 'op' broadcast reduces the doc, adopts the version, and notifies", () => {
  const t = fakeTransport();
  const store = createRoomStore({ transport: t });
  t.receive(stateFrame(5));
  let notifyCount = 0;
  store.subscribe(() => { notifyCount++; });

  t.receive({ type: "op", op: addStory("S2"), version: 6 });

  assert.ok("S2" in store.getState().stories, "broadcast op applied");
  assert.equal(notifyCount, 1);
  // the adopted version is used as the next op's baseVersion
  store.dispatch(addStory("S3"));
  assert.equal(t.sent.at(-1).baseVersion, 6);
});

test("a 'nack' frame calls onNack and changes neither doc nor version", () => {
  const t = fakeTransport();
  let nackReason = null;
  const store = createRoomStore({ transport: t, onNack: (r) => { nackReason = r; } });
  t.receive(stateFrame(5));
  const before = store.getState();

  t.receive({ type: "nack", opId: "x", reason: "stale: room at version 6" });

  assert.equal(nackReason, "stale: room at version 6");
  assert.equal(store.getState(), before, "doc unchanged on nack");
  store.dispatch(addStory("S2"));
  assert.equal(t.sent.at(-1).baseVersion, 5, "version unchanged on nack");
});

test("EDIT_STORY dispatch sends ONLY the changed fields as a delta (MP3)", () => {
  const t = fakeTransport();
  const store = createRoomStore({ transport: t });
  t.receive(stateFrame(5)); // S1 = { title:"S1", summary:"", points:3, epicId:null }

  // The editor submits the whole story; only points actually changed.
  store.dispatch({ type: "EDIT_STORY", payload: { id: "S1", title: "S1", summary: "", points: 9, epicId: null } });

  const sent = t.sent.at(-1);
  assert.equal(sent.op.type, "EDIT_STORY");
  assert.deepEqual(sent.op.payload, { id: "S1", points: 9 }, "id + only the changed field");
});

test("EDIT_STORY delta carries every changed field and omits unchanged ones", () => {
  const t = fakeTransport();
  const store = createRoomStore({ transport: t });
  t.receive(stateFrame(5));

  store.dispatch({ type: "EDIT_STORY", payload: { id: "S1", title: "new", summary: "added", points: 3, epicId: null } });

  // title + summary changed; points + epicId unchanged → omitted.
  assert.deepEqual(t.sent.at(-1).op.payload, { id: "S1", title: "new", summary: "added" });
});

test("a 'presence' frame invokes onPresence and does not touch plan state/version (MP5)", () => {
  const t = fakeTransport();
  let presence = null;
  const store = createRoomStore({ transport: t, onPresence: (p) => { presence = p; } });
  t.receive(stateFrame(5));
  const before = store.getState();

  const list = [{ id: "p1", name: "Ann", identity: "verified" }, { id: "p2", name: "Guest", identity: "claimed" }];
  t.receive({ type: "presence", participants: list });

  assert.deepEqual(presence, list);
  assert.equal(store.getState(), before, "plan state unchanged by presence");
  store.dispatch(addStory("S2"));
  assert.equal(t.sent.at(-1).baseVersion, 5, "version unchanged by presence");
});

test("a dropped connection fires onDisconnect once and silences every send", () => {
  const t = fakeTransport();
  let disconnects = 0;
  const store = createRoomStore({ transport: t, onDisconnect: () => { disconnects++; } });
  t.receive(stateFrame(1));
  t.drop();
  store.dispatch(addStory("S2"));
  store.sendCursor(0.5, 0.5);
  store.clearCursor();
  assert.equal(disconnects, 1);
  assert.deepEqual(t.sent, []);
});
