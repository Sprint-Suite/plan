// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePoints, isNonEmptyTitle, singleLineTitle, parseVelocity } from "../public/js/validate.js";
import { validatePlan } from "../public/js/plan-io.js";
import { createInitialState, reduce } from "../public/js/store.js";

// Brief asserted case 8
test("parsePoints accepts positive integers", () => {
  assert.equal(parsePoints(1), 1);
  assert.equal(parsePoints(3), 3);
  assert.equal(parsePoints(8), 8);
  assert.equal(parsePoints(34), 34);
  assert.equal(parsePoints("5"), 5); // string input from a text field
});

test("parsePoints rejects 0, negatives, non-integers and empty as null", () => {
  assert.equal(parsePoints(0), null);
  assert.equal(parsePoints(-2), null);
  assert.equal(parsePoints(2.5), null);
  assert.equal(parsePoints(""), null);
  assert.equal(parsePoints("  "), null);
  assert.equal(parsePoints("abc"), null);
  assert.equal(parsePoints(null), null);
  assert.equal(parsePoints(undefined), null);
  assert.equal(parsePoints(NaN), null);
});

test("isNonEmptyTitle requires non-whitespace content", () => {
  assert.equal(isNonEmptyTitle("Checkout"), true);
  assert.equal(isNonEmptyTitle("  x  "), true);
  assert.equal(isNonEmptyTitle(""), false);
  assert.equal(isNonEmptyTitle("   "), false);
});

test("singleLineTitle collapses newlines/whitespace to one line and trims", () => {
  assert.equal(singleLineTitle("Q3 plan"), "Q3 plan"); // unchanged
  assert.equal(singleLineTitle("  Q3 plan  "), "Q3 plan"); // trimmed
  assert.equal(singleLineTitle("Q3\nplan"), "Q3 plan"); // contenteditable Enter
  assert.equal(singleLineTitle("Q3\r\n\tplan"), "Q3 plan"); // pasted CRLF + tab
  assert.equal(singleLineTitle("Q3   big   plan"), "Q3 big plan"); // runs collapse
  assert.equal(singleLineTitle("\n\n  "), ""); // newlines-only → empty
});

test("parseVelocity rounds to a positive integer, clamping below at 1", () => {
  assert.equal(parseVelocity("20"), 20);
  assert.equal(parseVelocity("20.4"), 20);
  assert.equal(parseVelocity("0"), 1);
  assert.equal(parseVelocity("-5"), 1);
});

test("parseVelocity refuses non-numeric and unsafe magnitudes", () => {
  assert.equal(parseVelocity("abc"), null);
  assert.equal(parseVelocity(""), null);
  assert.equal(parseVelocity("9007199254740992"), null);
});

test("any velocity parseVelocity accepts survives a save/restore round trip", () => {
  for (const input of ["1", "33", "9007199254740991"]) {
    const v = /** @type {number} */ (parseVelocity(input));
    const saved = JSON.parse(JSON.stringify(reduce(createInitialState("2026-07-06"), { type: "SET_VELOCITY", payload: v })));
    assert.equal(validatePlan(saved).ok, true, input);
  }
});
