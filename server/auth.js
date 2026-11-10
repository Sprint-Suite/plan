// @ts-check
/**
 * Productionise slice 2 — the auth provider seam.
 *
 * Two implementations behind one interface so the server (and decideUpgrade)
 * never knows which is live:
 *   - STUB (default, no hub): wraps auth-seam.js. requireAuth reads a test
 *     session header; used by tests and open-link dev.
 *   - REAL (env-configured): wraps @suite/auth-client. Loaded by DYNAMIC import
 *     so module load + CI never need the package or a running hub — the package
 *     is a deploy-time dependency (see docs/phase2-mp2-hub-registration.md).
 *
 * Interface: { mode, verifySession(headers), requireAuth, companyOf(req), userOf(req), mountRoutes(app) }.
 * verifySession is normalised to { userId, entitled, company } where `company` is
 * the company ID STRING, so decideUpgrade's `session.company === room.companyId`
 * check is identical for both providers (the hub returns company as {id,name};
 * the real adapter maps it to its id).
 */

import { verifySession as stubVerify } from "./auth-seam.js";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ mode: string, verifySession: (h: any) => any, requireAuth: Function, companyOf: (req: any) => string | null, userOf: (req: any) => string | null, mountRoutes: (app: any) => void }>}
 */
export async function createAuthProvider(env = {}) {
  return env.HUB_BASE_URL ? createRealProvider(env) : createStubProvider();
}

function createStubProvider() {
  return {
    mode: "stub",
    verifySession: (/** @type {any} */ headers) => stubVerify(headers),
    requireAuth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      const s = stubVerify(req.headers);
      if (!s) return res.status(401).json({ error: "unauthorized" });
      req.user = s;
      next();
    },
    companyOf: (/** @type {any} */ req) => req.user?.company ?? null,
    userOf: (/** @type {any} */ req) => req.user?.userId ?? null,
    mountRoutes: () => {},
  };
}

/** @param {Record<string, string | undefined>} env */
async function createRealProvider(env) {
  let mod;
  try {
    mod = await import("@suite/auth-client");
  } catch {
    throw new Error(
      "@suite/auth-client not installed — it is a deploy-time dependency; see docs/phase2-mp2-hub-registration.md",
    );
  }
  const client = mod.createAuthClient({
    appName: env.APP_NAME || "plan",
    hubBaseUrl: env.HUB_BASE_URL,
    hubApiKey: env.HUB_API_KEY,
    cookieName: "plan_session",
    cookieDomain: env.COOKIE_DOMAIN,
    dbPath: env.APP_SESSIONS_DB || "./data/plan-sessions.db",
  });
  return {
    mode: "real",
    verifySession: async (/** @type {any} */ headers) => {
      const s = await client.verifySession(headers.cookie);
      if (!s) return null;
      return { userId: s.userId, entitled: s.entitled, company: s.company?.id ?? null };
    },
    requireAuth: client.requireAuth,
    companyOf: (/** @type {any} */ req) => req.user?.company?.id ?? req.user?.company ?? null,
    userOf: (/** @type {any} */ req) => req.user?.id ?? null,
    mountRoutes: (/** @type {any} */ app) => {
      app.use("/auth-client", client.staticAssets);
      app.get("/auth/launch", client.handleLaunch);
      app.get("/auth/logout", client.handleLogout);
      app.get("/auth/whoami", client.handleWhoami);
      app.post("/api/heartbeat", client.handleHeartbeat);
    },
  };
}
