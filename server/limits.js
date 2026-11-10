// @ts-check
/**
 * Resource limits for the rooms service, and the two limiter primitives they
 * use. Single-user plans never reach the server, so none of this touches
 * validatePlan. Every limit can be overridden per server instance (tests).
 */

const MAX_DOC_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = MAX_DOC_BYTES + 64 * 1024;

export const LIMITS = Object.freeze({
  maxDocBytes: MAX_DOC_BYTES, // UTF-8 JSON size of one room document
  maxFrameBytes: MAX_FRAME_BYTES, // any op derived from a permitted doc fits
  maxCreateBodyBytes: 2 * MAX_DOC_BYTES, // POST /rooms body: doc plus envelope
  // Outbound backlog before a slow reader is cut. Must exceed the largest frame
  // (a full state frame), or a healthy joiner is cut by the frame after it.
  maxBufferedBytes: 2 * MAX_FRAME_BYTES,
  opRate: 20, opBurst: 40,
  cursorRate: 40, cursorBurst: 60,
  upgradeRate: 50, upgradeBurst: 100,
  maxRoomSockets: 50, maxTotalSockets: 500, maxPendingUpgrades: 100,
  roomsPerUserPerHour: 20,
  maxNameLength: 40,
  // Server pings keep idle room tunnels open through proxies; a socket that
  // misses a whole interval without a pong is cut.
  pingIntervalMs: 30_000,
});

/**
 * Defaults to a monotonic clock, and never refills by negative time, so a
 * wall-clock step backwards cannot drain the bucket.
 * @param {{ rate: number, burst: number, now?: () => number }} opts  rate per second
 * @returns {{ take: () => boolean }}
 */
export function createTokenBucket({ rate, burst, now = () => performance.now() }) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + (Math.max(0, t - last) / 1000) * rate);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * At most `max` events per key in any rolling `windowMs`. Every call sweeps
 * expired timestamps across all keys, so idle keys do not accumulate.
 * @param {{ max: number, windowMs: number, now?: () => number }} opts
 * check() only tests; record() spends; allow() does both.
 * @returns {{ check: (key: string) => boolean, record: (key: string) => void, allow: (key: string) => boolean, size: () => number }}
 */
export function createWindowLimiter({ max, windowMs, now = Date.now }) {
  /** @type {Map<string, number[]>} */
  const events = new Map();
  const sweep = (/** @type {number} */ t) => {
    for (const [key, times] of events) {
      const live = times.filter((x) => t - x < windowMs);
      if (live.length) events.set(key, live);
      else events.delete(key);
    }
  };
  const check = (/** @type {string} */ key) => {
    sweep(now());
    return (events.get(key)?.length ?? 0) < max;
  };
  const record = (/** @type {string} */ key) => {
    events.set(key, [...(events.get(key) ?? []), now()]);
  };
  return {
    check,
    record,
    allow(key) {
      if (!check(key)) return false;
      record(key);
      return true;
    },
    size: () => events.size,
  };
}
