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
});

/**
 * @param {{ rate: number, burst: number, now?: () => number }} opts  rate per second
 * @returns {{ take: () => boolean }}
 */
export function createTokenBucket({ rate, burst, now = Date.now }) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate);
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
 * @returns {{ allow: (key: string) => boolean, size: () => number }}
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
  return {
    allow(key) {
      const t = now();
      sweep(t);
      const times = events.get(key) ?? [];
      if (times.length >= max) return false;
      events.set(key, [...times, t]);
      return true;
    },
    size: () => events.size,
  };
}
