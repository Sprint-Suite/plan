// @ts-check
/**
 * Phase 3 entry gate. Pure decision (decideEntry) + the whoami adapter
 * (fetchSession). The gate runs in main.js at boot, before anything renders.
 *
 * Threat model: single-user data is client-side localStorage and the source is
 * public, so this is a PRODUCT FUNNEL, not a security boundary — collaborative
 * rooms are already server-gated by decideUpgrade. A room link therefore always
 * bypasses the gate (link possession + the server token check is the real gate).
 *
 * DOM-free at import time: fetchSession touches `fetch` only when called, so
 * node:test can import decideEntry directly.
 */

/**
 * @param {{ hasRoomLink: boolean, session: "authed"|"anon"|"no-auth-system"|"error" }} input
 * @returns {{ mode: "room"|"single-user"|"redirect", hasSuiteSession: boolean }}
 */
export function decideEntry({ hasRoomLink, session }) {
  // A room link bypasses the gate entirely; the server enforces the token.
  if (hasRoomLink) {
    return { mode: "room", hasSuiteSession: session === "authed" };
  }
  // No link: a real session OR a dev box with no auth system mounted => the
  // single-user board. (no-auth-system keeps local dev working, where /auth/
  // whoami 404s because the stub provider mounts no routes.)
  if (session === "authed" || session === "no-auth-system") {
    return { mode: "single-user", hasSuiteSession: session === "authed" };
  }
  // No link, anon or whoami error (fail closed) => out to the suite.
  return { mode: "redirect", hasSuiteSession: false };
}

/**
 * Pure classifier for a /auth/whoami response. Split out so the body-shape
 * logic is unit-tested without a live fetch.
 *
 * The real @suite/auth-client handleWhoami returns 200 with `{ authed: boolean }`
 * for BOTH states (it is a "who am I" probe, not a 401 gate) — verified on prod
 * 2026-06-17 — so the body flag is load-bearing. 404 = no auth routes mounted
 * (dev/stub). 401 / status 0 / opaqueredirect = a cross-origin 302→hub-login.
 * A 2xx with no recognised flag fails CLOSED (anon), so the gate never admits a
 * visitor it cannot positively confirm.
 * @param {{ status: number, type?: string, body?: any }} res
 * @returns {"authed"|"anon"|"no-auth-system"|"error"}
 */
export function sessionFromResponse({ status, type, body }) {
  if (status === 404) return "no-auth-system";
  if (status === 401 || status === 0 || type === "opaqueredirect") return "anon";
  if (status < 200 || status >= 300) return "error";
  const b = body || {};
  if (typeof b.authed === "boolean") return b.authed ? "authed" : "anon";
  if (typeof b.authenticated === "boolean") return b.authenticated ? "authed" : "anon";
  if (typeof b.loggedIn === "boolean") return b.loggedIn ? "authed" : "anon";
  if (b.userId != null) return "authed";
  return "anon"; // 2xx with no recognised flag: fail closed.
}

/**
 * Ask the server who we are. `redirect:"manual"` so the real auth-client's
 * 302→hub-login surfaces as an opaqueredirect (status 0) rather than fetch
 * following it cross-origin. Classification is delegated to sessionFromResponse.
 * @returns {Promise<"authed"|"anon"|"no-auth-system"|"error">}
 */
export async function fetchSession() {
  let res;
  try {
    res = await fetch("/auth/whoami", { redirect: "manual" });
  } catch {
    return "error";
  }
  let body = /** @type {any} */ ({});
  if (res.ok) {
    try { body = await res.json(); } catch { /* non-JSON 2xx: classifier fails closed */ }
  }
  return sessionFromResponse({ status: res.status, type: res.type, body });
}

/**
 * Keep a suite user's Sprint Suite login alive while plan is open: the suite's
 * heartbeat script checks in every minute (the suite ends an idle login after
 * 30 minutes). Suite users only — the script reloads the page on a 401, which
 * a guest (no plan login) would get every time.
 * @param {{ hasSuiteSession: boolean, doc?: Document }} opts
 */
export function startSuiteHeartbeat({ hasSuiteSession, doc = document }) {
  if (!hasSuiteSession) return;
  const script = doc.createElement("script");
  script.src = "/auth-client/heartbeat.js";
  script.defer = true;
  doc.head.append(script);
}
