// tests/auth-gate.test.js
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEntry, sessionFromResponse, startSuiteHeartbeat } from "../public/js/auth-gate.js";

test("a room link always takes the room path, whatever the session", () => {
  for (const session of ["authed", "anon", "no-auth-system", "error"]) {
    assert.equal(decideEntry({ hasRoomLink: true, session }).mode, "room");
  }
});
test("room link + suite session => room, hasSuiteSession true", () => {
  const r = decideEntry({ hasRoomLink: true, session: "authed" });
  assert.equal(r.mode, "room");
  assert.equal(r.hasSuiteSession, true);
});
test("room link + no session => room as a guest (hasSuiteSession false)", () => {
  assert.equal(decideEntry({ hasRoomLink: true, session: "anon" }).hasSuiteSession, false);
});
test("no link + authed => single-user with a suite session", () => {
  const r = decideEntry({ hasRoomLink: false, session: "authed" });
  assert.equal(r.mode, "single-user");
  assert.equal(r.hasSuiteSession, true);
});
test("no link + no auth system (dev/stub) => single-user, no suite session", () => {
  const r = decideEntry({ hasRoomLink: false, session: "no-auth-system" });
  assert.equal(r.mode, "single-user");
  assert.equal(r.hasSuiteSession, false);
});
test("no link + anon => redirect (locked down)", () => {
  assert.equal(decideEntry({ hasRoomLink: false, session: "anon" }).mode, "redirect");
});
test("no link + whoami error => redirect (fail closed)", () => {
  assert.equal(decideEntry({ hasRoomLink: false, session: "error" }).mode, "redirect");
});

// --- sessionFromResponse: the whoami body classifier --------------------------
// The real @suite/auth-client handleWhoami returns 200 with { authed: boolean }
// for BOTH states (it is a "who am I" probe, not a 401 gate), so the body flag
// is load-bearing. A 200 {authed:false} that fell through to "authed" was a
// fail-open bug (the lockdown silently admitted anonymous visitors).
test("200 {authed:false} (real anon shape) => anon", () => {
  assert.equal(sessionFromResponse({ status: 200, type: "basic", body: { authed: false } }), "anon");
});
test("200 {authed:true} (real authed shape) => authed", () => {
  assert.equal(sessionFromResponse({ status: 200, type: "basic", body: { authed: true } }), "authed");
});
test("200 with no recognised flag => anon (fail closed)", () => {
  assert.equal(sessionFromResponse({ status: 200, type: "basic", body: {} }), "anon");
});
test("404 => no-auth-system (dev/stub, no routes mounted)", () => {
  assert.equal(sessionFromResponse({ status: 404, type: "basic", body: {} }), "no-auth-system");
});
test("401 => anon", () => {
  assert.equal(sessionFromResponse({ status: 401, type: "basic", body: {} }), "anon");
});
test("opaqueredirect (cross-origin 302 to hub login) => anon", () => {
  assert.equal(sessionFromResponse({ status: 0, type: "opaqueredirect", body: {} }), "anon");
});
test("5xx => error (fail closed via decideEntry)", () => {
  assert.equal(sessionFromResponse({ status: 502, type: "basic", body: {} }), "error");
});
test("defensive: 200 {authenticated:true} / {userId} still => authed", () => {
  assert.equal(sessionFromResponse({ status: 200, type: "basic", body: { authenticated: true } }), "authed");
  assert.equal(sessionFromResponse({ status: 200, type: "basic", body: { userId: "u1" } }), "authed");
});

/** A minimal document double that records appended scripts. */
function fakeDoc() {
  const appended = /** @type {any[]} */ ([]);
  return {
    appended,
    createElement: (/** @type {string} */ tag) => ({ tag, src: "", defer: false }),
    head: { append: (/** @type {any} */ el) => appended.push(el) },
  };
}

test("a suite user gets the suite heartbeat script, which keeps their suite login alive", () => {
  const doc = fakeDoc();
  startSuiteHeartbeat({ hasSuiteSession: true, doc: /** @type {any} */ (doc) });
  assert.equal(doc.appended.length, 1);
  assert.equal(doc.appended[0].tag, "script");
  assert.equal(doc.appended[0].src, "/auth-client/heartbeat.js");
});

test("a guest never loads the heartbeat (it would reload the page on every 401)", () => {
  const doc = fakeDoc();
  startSuiteHeartbeat({ hasSuiteSession: false, doc: /** @type {any} */ (doc) });
  assert.equal(doc.appended.length, 0);
});
