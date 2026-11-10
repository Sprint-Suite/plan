// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenBucket, createWindowLimiter } from "../server/limits.js";

function clock() {
  let t = 0;
  return { now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
}

test("token bucket allows a burst, refuses beyond it, and refills at the rate", () => {
  const c = clock();
  const bucket = createTokenBucket({ rate: 10, burst: 3, now: c.now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  c.advance(100); // 10/s => one token per 100 ms
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  c.advance(10_000);
  for (let i = 0; i < 3; i++) assert.equal(bucket.take(), true, "refill is capped at the burst");
  assert.equal(bucket.take(), false);
});

test("window limiter caps each key independently over a rolling window", () => {
  const c = clock();
  const limiter = createWindowLimiter({ max: 2, windowMs: 1000, now: c.now });
  assert.deepEqual([limiter.allow("u1"), limiter.allow("u1"), limiter.allow("u1")], [true, true, false]);
  assert.equal(limiter.allow("u2"), true);
  c.advance(1001);
  assert.equal(limiter.allow("u1"), true);
});

test("window limiter can check without recording", () => {
  const limiter = createWindowLimiter({ max: 1, windowMs: 1000, now: () => 0 });
  assert.equal(limiter.check("u1"), true);
  assert.equal(limiter.check("u1"), true, "checking alone uses nothing");
  limiter.record("u1");
  assert.equal(limiter.check("u1"), false);
});

test("window limiter drops idle keys once their window has passed", () => {
  const c = clock();
  const limiter = createWindowLimiter({ max: 5, windowMs: 1000, now: c.now });
  limiter.allow("idle");
  c.advance(1001);
  limiter.allow("active");
  assert.equal(limiter.size(), 1);
});
