// @ts-check
/**
 * App bootstrap: build/restore the store, wire the settings-strip controls to
 * dispatch, autosave on every change, and render on every state notification.
 * The view never mutates state — it only dispatches named actions.
 */

import { createStore, createInitialState } from "./store.js";
import { createRoomStore, wsTransport } from "./sync-client.js";
import { wireCollaborate, openInviteModal } from "./collaborate.js";
import { resolveJoinName } from "./room-join.js";
import { promptForName, showConnectionLost } from "./room-gate.js";
import { toBoardFraction, fromBoardFraction, reconcileCursors } from "./cursors.js";
import {
  setStartDate,
  setDurationMonths,
  setSprintWeeks,
  setVelocity,
  setBufferPct,
  setPlanTitle,
  loadPlan,
  newPlan,
  moveStory,
  setStoryStretch,
} from "./actions.js";
import { nextMonday } from "./date.js";
import { validatePlan, migratePlan, exportPlan, extractPlan } from "./plan-io.js";
import { reportModel, toMarkdown, toHtml, toCsv } from "./report.js";
import { render } from "./render.js";
import { toggleCollapsed } from "./backlog.js";
import { openCardEditor } from "./card-editor.js";
import { confirmModal } from "./modal.js";
import { openEpicEditor } from "./epic-editor.js";
import { setupDrag, isDragging } from "./drag.js";
import { dismissBanner, clearDismissedBanners } from "./banner.js";
import { openResumePrompt, openInvalidPrompt } from "./resume-prompt.js";
import { singleLineTitle, parseVelocity, isISODate } from "./validate.js";
import { decideEntry, fetchSession } from "./auth-gate.js";
import { launchUrl } from "./suite-urls.js";
import { wireLogout } from "./logout.js";

const STORAGE_KEY = "sprintplan:board";

/**
 * Today's local calendar date as ISO. This is the ONE place we read the system
 * clock; all downstream calendar maths is pure string arithmetic (see date.js).
 * @returns {string}
 */
function todayISO() {
  const now = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The current instant as an ISO timestamp. The second (and last) place we read
 * the system clock, used only to stamp the persistence/export envelopes (savedAt,
 * exportedAt). Like todayISO, this is a boundary read: the timestamp never enters
 * store state and never passes through an action — the reducer stays time-free.
 * @returns {string}
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * lastReturnedStoryIds is transient toast-trigger state, meaningless across a
 * load boundary (R6). Normalise it to [] on every restored/imported plan so no
 * stale "returned to backlog" toast fires on load.
 * @param {import("./store.js").PlanState} plan
 */
function normalise(plan) {
  return { ...plan, lastReturnedStoryIds: [] };
}

/** A fresh default plan anchored at the next working Monday (G1). */
function freshPlan() {
  return createInitialState(nextMonday(todayISO()));
}

/**
 * @typedef {{ kind: "none" }
 *   | { kind: "valid", plan: import("./store.js").PlanState, savedAt: string | undefined }
 *   | { kind: "invalid", reason: string, raw: string }} SaveVerdict
 */

/**
 * CLASSIFY the autosaved board without seeding anything (Brief 6, R2). The store
 * always boots fresh; this only inspects the stored bytes so the load-time prompt
 * knows what to offer. Three outcomes: none (first run); valid (resumable plan +
 * its savedAt); invalid (a parseable-or-not save that fails the pipeline — we
 * keep the RAW string and the human reason so the prompt can surface and rescue
 * it, R5). Crucially this READS but never WRITES, so the bad bytes stay intact
 * under the prompt until the user acts — that is what makes the R5 rescue real.
 * @returns {SaveVerdict}
 */
function classifySave() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { kind: "none" }; // storage blocked: treat as a clean first run
  }
  if (raw == null) return { kind: "none" };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "the saved data isn't valid JSON", raw };
  }
  const ext = extractPlan(parsed, "restore");
  if (!ext.ok) return { kind: "invalid", reason: ext.reason, raw };
  const mig = migratePlan(ext.plan);
  if (!mig.ok) return { kind: "invalid", reason: mig.reason, raw };
  const val = validatePlan(mig.plan);
  if (!val.ok) return { kind: "invalid", reason: val.reason, raw };

  const savedAt = parsed && typeof parsed === "object" ? parsed.savedAt : undefined;
  return { kind: "valid", plan: normalise(val.plan), savedAt };
}

// --- Dual-mode fork (MP1, R3) ----------------------------------------------
// A `?room=` param takes the multiplayer path: a server-authoritative room store
// over a ws to the room service, NO autosave and NO resume prompt (the server is
// the source of truth; touching sprintplan:board would clobber the user's local
// plan). Absent the param, the local single-user app below runs exactly as it
// always has. The room store mirrors createStore's interface (R2), so every view
// module is reused unchanged.
const roomParams = new URLSearchParams(location.search);
const ROOM_ID = roomParams.get("room");
const IN_ROOM = ROOM_ID != null && ROOM_ID !== "";

// --- Phase 3 entry gate (suite-gated access) -------------------------------
// Before anything renders: a room link bypasses (server enforces the token);
// otherwise require a suite session or redirect out to the suite. The overlay
// in index.html covers the page until we know we're staying.
const sessionStatus = await fetchSession();
const entry = decideEntry({ hasRoomLink: IN_ROOM, session: sessionStatus });
if (entry.mode === "redirect") {
  location.replace(launchUrl());
  await new Promise(() => {}); // halt the module: the navigation is in flight
}
document.getElementById("boot-overlay")?.remove(); // staying — reveal the app
const HAS_SUITE_SESSION = entry.hasSuiteSession;

/** Translate a server nack reason into a user-facing toast line. */
function roomNackMessage(/** @type {string} */ reason) {
  if (reason.includes("not allowed")) return "That action isn't available in a shared room.";
  if (reason.includes("stale")) return "Someone else edited that first — showing the latest.";
  return `Change not applied: ${reason}`;
}

// #3 name-on-join gate: in a room, require a real name BEFORE the socket opens.
// The room store is created synchronously just below, and its transport/name read
// from roomParams — so resolving the gate here (top-level await; main.js is a
// module) and writing the chosen name back into roomParams makes both the ws URL
// and the recorded name correct. history.replaceState keeps the name on refresh.
// The local path has no await, so it stays byte-for-byte identical.
if (IN_ROOM) {
  const resolved = resolveJoinName(roomParams.get("name"));
  if (resolved.needsPrompt) {
    const chosen = await promptForName();
    roomParams.set("name", chosen);
    history.replaceState(null, "", location.pathname + "?" + roomParams.toString());
  }
}

// The local store ALWAYS boots fresh (R2): a saved board is restored only by an
// explicit, prompted loadPlan dispatch, never substituted at boot. Two safety
// properties fall out — the saved board never renders under the prompt (no
// last-quarter flash on a shared screen), and autosave (dispatch-only) cannot
// overwrite the saved bytes until the user chooses (the R5 rescue stays open).
const store = IN_ROOM
  ? createRoomStore({
      transport: wsTransport(location.origin.replace(/^http/, "ws") + "/?" + roomParams.toString()),
      name: roomParams.get("name") ?? "guest",
      onNack: (reason) => flash(roomNackMessage(reason)),
      onPresence: (list) => renderPresence(list),
      onCursor: (msg) => handleCursor(/** @type {HTMLElement} */ (document.getElementById("board")), msg),
      onDisconnect: showConnectionLost,
    })
  : createStore(freshPlan());

/**
 * The latest presence snapshot keyed by participant id: the colour + name a remote
 * cursor reads (phase2-build5). Kept in step by renderPresence so cursor frames
 * stay tiny (id + position only) and carry no colour of their own.
 * @type {Map<string, { name: string, colour: string }>}
 */
const presenceById = new Map();

/** Render the live presence strip (MP5, room mode). A claimed (open-link) guest
 * is marked distinctly so a self-asserted name is never read as a member. The
 * initial badge is tinted with the participant's server-assigned colour (phase2-
 * build5, R3) so it matches that person's cursor by construction. */
function renderPresence(/** @type {Array<{ id: string, name: string, identity: string, colour?: string }>} */ participants) {
  const host = document.getElementById("presence");
  if (!host) return;
  host.replaceChildren();
  presenceById.clear();
  for (const p of participants) {
    if (p.colour) presenceById.set(p.id, { name: p.name, colour: p.colour });
    const guest = p.identity === "claimed";
    const chip = document.createElement("span");
    chip.className = "presence-chip" + (guest ? " is-guest" : "");
    const initial = document.createElement("span");
    initial.className = "presence-initial";
    initial.textContent = (p.name || "?").trim().charAt(0).toUpperCase() || "?";
    // Tint the badge with the participant's colour (R3: badge and cursor share the
    // ONE colour, so they match by construction — for guests too, so two guests are
    // told apart). The guest distinction stays in the "(guest)" label + chip tone,
    // not the badge colour. White text already reads on every palette hue.
    if (p.colour) initial.style.background = p.colour;
    const name = document.createElement("span");
    name.className = "presence-name";
    name.textContent = guest ? `${p.name} (guest)` : p.name;
    chip.append(initial, name);
    host.append(chip);
  }
  host.hidden = participants.length === 0;
  // #10: keep the board's LIVE room header participant count in step.
  const count = document.getElementById("room-live-count");
  if (count) count.textContent = String(participants.length);
  // phase2-build5: a disconnect fires only a presence frame (never a `gone`
  // cursor), so drop any drawn cursor whose participant has left.
  for (const id of reconcileCursors([...drawnCursors.keys()], participants.map((p) => p.id))) {
    removeCursor(id);
  }
}

// --- phase2-build5: the live-cursor overlay layer ---------------------------
// Decoupled from the render/paint loop (R5): render() rebuilds #board via
// replaceChildren every paint, so cursors live in their OWN fixed overlay that
// render() never touches and the store never drives. The overlay is updated
// directly by the cursor message handler below. pointer-events:none (CSS) means
// it can never become a drop target or swallow a board click.

/** @type {Map<string, { el: HTMLElement, arrow: SVGElement, label: HTMLElement }>} */
const drawnCursors = new Map();

/** The board's current viewport box + full content size — the metrics both the
 * sender (pointer -> fraction) and the receiver (fraction -> point) read from
 * THEIR OWN board. left/top come from getBoundingClientRect (already scroll-
 * adjusted, so NO window-scroll term is added — that would double-count). */
function boardMetrics(/** @type {HTMLElement} */ board) {
  const r = board.getBoundingClientRect();
  return { left: r.left, top: r.top, width: board.scrollWidth, height: board.scrollHeight };
}

/** Create (once) or update a remote participant's cursor at viewport point (x,y). */
function upsertCursor(/** @type {string} */ id, /** @type {string} */ colour, /** @type {string} */ name, /** @type {number} */ x, /** @type {number} */ y) {
  const layer = document.getElementById("cursor-layer");
  if (!layer) return;
  let c = drawnCursors.get(id);
  if (!c) {
    const el = document.createElement("div");
    el.className = "cursor";
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("class", "cursor-arrow");
    arrow.setAttribute("viewBox", "0 0 14 18");
    arrow.setAttribute("width", "14");
    arrow.setAttribute("height", "18");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M0 0 L0 15 L4 11 L7 17 L10 16 L7 10 L13 10 Z");
    arrow.append(path);
    const label = document.createElement("span");
    label.className = "cursor-label";
    el.append(arrow, label);
    layer.append(el);
    c = { el, arrow, label };
    drawnCursors.set(id, c);
  }
  /** @type {any} */ (c.arrow).style.fill = colour;
  c.label.style.background = colour;
  c.label.textContent = name; // name only; the rail owns the (guest) marker
  c.el.style.transform = `translate(${x}px, ${y}px)`;
}

/** Remove a drawn cursor (on `gone` or a disconnect reconcile). */
function removeCursor(/** @type {string} */ id) {
  const c = drawnCursors.get(id);
  if (!c) return;
  c.el.remove();
  drawnCursors.delete(id);
}

/** Apply one cursor frame from the room (phase2-build5). Colour + name come from
 * the latest presence snapshot, so the frame itself stays {id, x, y | gone}. */
function handleCursor(/** @type {HTMLElement} */ board, /** @type {{ id: string, x?: number, y?: number, gone?: boolean }} */ msg) {
  if (msg.gone) { removeCursor(msg.id); return; }
  if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
  const meta = presenceById.get(msg.id);
  if (!meta) return; // no colour/name yet (presence not seen) — skip until it is
  const pt = fromBoardFraction({ x: msg.x, y: msg.y }, boardMetrics(board));
  upsertCursor(msg.id, meta.colour, meta.name, pt.x, pt.y);
}

/** A trailing throttle: caps calls to one per `ms` but always delivers the LAST
 * arguments (so the final pointer position is never dropped). `.cancel()` clears a
 * pending trailing call — used on pointerleave so no stale position lands after a
 * `gone`. */
function throttle(/** @type {(...a: any[]) => void} */ fn, /** @type {number} */ ms) {
  let last = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */ let timer = null;
  /** @type {any[]} */ let lastArgs = [];
  const run = () => { last = performance.now(); timer = null; fn(...lastArgs); };
  const wrapped = (/** @type {any[]} */ ...args) => {
    lastArgs = args;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) { if (timer) { clearTimeout(timer); } run(); }
    else if (!timer) { timer = setTimeout(run, wait); }
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

// Autosave: every action persists immediately (cross-cutting rule: refresh
// loses nothing). Persist the { savedAt, plan } envelope (R7) — savedAt is
// stamped HERE, at the serialize boundary, never in store state. Brief 6's
// resume card reads savedAt for free; this brief writes it but renders nothing.
// LOCAL MODE ONLY (R3): in a room the server owns persistence.
if (!IN_ROOM) {
  store.subscribe((state) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: nowISO(), plan: state }));
    } catch {
      // Storage full/blocked — non-fatal for the in-memory session.
    }
  });
}

// Render on every change, then (re)wire dragula over the fresh DOM. render()
// rebuilds the board/backlog via replaceChildren, so the drake must be rebuilt
// after each paint. Run once now for the initial paint.
function paint(/** @type {import("./store.js").PlanState} */ state) {
  render(state);
  setupDrag(store);
}
store.subscribe(paint);
paint(store.getState());

// --- Wire the settings strip ------------------------------------------------

/** @param {string} id @param {string} evt @param {(value: string) => void} handler */
function on(id, evt, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, () => handler(/** @type {HTMLInputElement} */ (el).value));
}

// Settings changes are the only paths that regenerate the board. They clear the
// dismissed-banner set first: capacity just changed, so every still-over banner
// must re-arm (this closes the stale-index hole — a re-grown sprint must not
// inherit an old dismissal). View state never enters the store; this just clears
// a view-local Set before the regenerating dispatch. MOVE_STORY and others do
// NOT clear it, preserving the per-session dismiss promise.
/** @param {{ type: string, payload?: any }} action */
function dispatchSettings(action) {
  clearDismissedBanners();
  store.dispatch(action);
}

on("ss-start", "change", (v) => isISODate(v) && dispatchSettings(setStartDate(v)));
on("ss-duration", "change", (v) => dispatchSettings(setDurationMonths(Number(v))));
on("ss-sprint-weeks", "change", (v) => dispatchSettings(setSprintWeeks(Number(v))));
on("ss-velocity", "change", (v) => {
  const n = parseVelocity(v);
  if (n !== null) dispatchSettings(setVelocity(n));
});
on("ss-buffer", "change", (v) => {
  const n = Math.min(99, Math.max(0, Math.round(Number(v))));
  if (Number.isFinite(n)) dispatchSettings(setBufferPct(n));
});

// Backlog panel: one delegated listener; rendered nodes carry data-act.
const backlogEl = document.getElementById("backlog");
backlogEl?.addEventListener("click", (e) => {
  if (isDragging()) return; // swallow the click that trails a drag
  const target = e.target instanceof Element ? e.target.closest("[data-act]") : null;
  if (!(target instanceof HTMLElement)) return;
  switch (target.dataset.act) {
    case "add-epic":
      openEpicEditor(store, null);
      break;
    case "edit-epic":
      openEpicEditor(store, target.dataset.epic ?? null);
      break;
    case "add-story":
      openCardEditor(store, { epicId: target.dataset.epic ?? null });
      break;
    case "edit-story":
      openCardEditor(store, { storyId: target.dataset.story });
      break;
    case "toggle-epic":
      if (target.dataset.epic) {
        toggleCollapsed(target.dataset.epic);
        paint(store.getState()); // collapse is view state; re-render + re-wire drag
      }
      break;
  }
});

// Board: one delegated listener. Placed cards open the card editor; the honesty
// banner's × dismisses that sprint's banner for the session. A click that trails
// a drag is swallowed. The dismiss button is a sibling of the sprint body (not
// inside a placed card), so it can never match the edit-story branch.
const boardEl = document.getElementById("board");
boardEl?.addEventListener("click", (e) => {
  if (isDragging()) return;
  const target = e.target instanceof Element ? e.target.closest("[data-act]") : null;
  if (!(target instanceof HTMLElement)) return;
  switch (target.dataset.act) {
    case "edit-story":
      if (target.dataset.story) openCardEditor(store, { storyId: target.dataset.story });
      break;
    case "dismiss-banner":
      dismissBanner(Number(target.dataset.sprintIndex));
      paint(store.getState()); // dismiss is view state; re-render + re-wire drag
      break;
    case "return-to-backlog":
      // #9: send a placed card home via the existing MOVE_STORY (allow-listed,
      // so it round-trips in a room). beforeId null = append to the backlog end.
      // A manual return fires no toast (the reducer leaves lastReturnedStoryIds
      // empty); only a settings-regeneration return toasts.
      if (target.dataset.story) {
        store.dispatch(moveStory({ storyId: target.dataset.story, target: { kind: "backlog" }, beforeId: null }));
      }
      break;
    case "toggle-stretch":
      // #build6: flip the stretch flag on a placed card. An explicit boolean read
      // from the latest state (LWW-clean in a room). A real action — works in both
      // local and room mode, unlike the build5 cursor side-channel.
      if (target.dataset.story) {
        const cur = store.getState().stories[target.dataset.story]?.stretch ?? false;
        store.dispatch(setStoryStretch({ id: target.dataset.story, stretch: !cur }));
      }
      break;
  }
});

// Plan title: editable h1 in the band (G6). A single-line field — Enter
// commits (blur) rather than inserting a newline, and a multi-line paste is
// flattened to one line. Commit on blur, normalised via singleLineTitle.
const titleEl = document.getElementById("plan-title");
if (titleEl) {
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleEl.blur();
    }
  });
  titleEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = singleLineTitle(e.clipboardData?.getData("text") ?? "");
    document.execCommand("insertText", false, text);
  });
  titleEl.addEventListener("blur", () => {
    store.dispatch(setPlanTitle(singleLineTitle(titleEl.textContent ?? "")));
  });
}

// --- Returned-to-backlog toast (G3) ----------------------------------------

const toastEl = document.getElementById("toast");
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** Show a transient, non-blocking message (G3 toast + board-file errors). */
function flash(/** @type {string} */ text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}
store.subscribe((state) => {
  const n = state.lastReturnedStoryIds.length;
  if (n === 0) return;
  flash(`${n} ${n === 1 ? "story" : "stories"} returned to backlog`);
});

// --- Board file I/O (Screen 5 ruling G8: the top-bar Save / load control) ---
// Board FILE only — never report export (P0 #6), never a New-plan button. The
// pure core (plan-io.js) does validate/migrate/extract/export; this is the thin
// browser glue (Blob download, file read) the brief keeps out of the unit net.

/** Filename-safe slug of the plan title, or a fallback. */
function slugify(/** @type {string | null} */ title) {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled-plan";
}

/** Trigger a browser download of `text` as `filename`. The thin glue the board
 * export, the invalid-save rescue, AND the report export (Brief 9) share; `mime`
 * defaults to JSON for the board callers, the report passes its own type. */
function downloadText(
  /** @type {string} */ text,
  /** @type {string} */ filename,
  /** @type {string} */ mime = "application/json",
) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download a plan as a self-identifying board .json (R2 header). Reused by the
 * top-bar Download control AND the Start-new escape hatch (on the SAVED plan). */
function downloadBoard(/** @type {import("./store.js").PlanState} */ state) {
  const payload = exportPlan(state, nowISO());
  downloadText(JSON.stringify(payload, null, 2), `${slugify(state.meta.title)}-${todayISO()}.json`);
}

/** Download the raw, verbatim stored bytes of an unreadable save (R5 rescue).
 * Verbatim, NOT reserialised: a structurally-broken save is handed back exactly
 * as stored so nothing recoverable is lost to reformatting. */
function downloadRaw(/** @type {string} */ text) {
  downloadText(text, `unreadable-board-${todayISO()}.json`);
}

document.getElementById("tb-export")?.addEventListener("click", () => downloadBoard(store.getState()));

// Collaborate (MP4): create a shared room from the current plan. Hidden inside a
// room (you are already collaborating); in local mode it offers to start one.
const collabBtn = document.getElementById("tb-collaborate");
if (collabBtn) {
  if (IN_ROOM) {
    // #1: in a room the create flow is meaningless — repurpose the slot into an
    // "Invite" control that re-surfaces THIS room's link (reconstructed from our
    // own params, personal name stripped). Local mode keeps the create dialog.
    collabBtn.textContent = "Invite";
    collabBtn.addEventListener("click", () =>
      openInviteModal({ room: roomParams.get("room") ?? "", token: roomParams.get("token") }));
  } else {
    wireCollaborate({ button: collabBtn, getPlan: () => store.getState(), flash });
  }
}

// Phase 3: the Log out button. Behaviour branches on whether this browser holds
// a real suite session (set by the entry gate), NOT on room vs single-user — a
// suite user in a room still logs out to the dashboard.
wireLogout({ button: document.getElementById("tb-logout"), hasSuiteSession: HAS_SUITE_SESSION });

// #10: in a room, give the board a live-room header treatment — the band eyebrow
// reads as a live room, the plan title BECOMES the room name (editable and synced
// live: SET_PLAN_TITLE is now room-allow-listed, P5 reversed on the director's
// call), and a LIVE indicator + participant count (kept in step by renderPresence)
// appears. Local mode shows none of it (R3).
if (IN_ROOM) {
  const eyebrow = document.querySelector(".band .eyebrow");
  if (eyebrow) eyebrow.textContent = "Live room";
  const live = document.getElementById("room-live");
  if (live) live.hidden = false;
}

// phase2-build5: broadcast THIS client's pointer over the board (room mode only,
// R2). A trailing throttle caps the socket to ~30 sends/sec while always sending
// the final position; pointerleave clears our cursor in everyone else's window and
// cancels any pending send so no stale position lands after the `gone`. The handler
// reads the board's live metrics on each move, so a mid-session resize/scroll is
// always reflected. The board element is stable across paints (render() replaces
// its CHILDREN, not the #board node itself).
if (IN_ROOM) {
  // Guarded by IN_ROOM, so `store` is the room store (its only shape with the
  // cursor transport); the cast narrows the createStore|createRoomStore union.
  const roomStore = /** @type {ReturnType<typeof createRoomStore>} */ (store);
  const cursorBoard = document.getElementById("board");
  if (cursorBoard) {
    const sendMove = throttle((/** @type {PointerEvent} */ e) => {
      const frac = toBoardFraction({ x: e.clientX, y: e.clientY }, boardMetrics(cursorBoard));
      roomStore.sendCursor(frac.x, frac.y);
    }, 33);
    cursorBoard.addEventListener("pointermove", /** @type {EventListener} */ (sendMove));
    cursorBoard.addEventListener("pointerleave", () => {
      sendMove.cancel();
      roomStore.clearCursor();
    });
  }
}

// --- Report export (Brief 9, P0 #6, ruling G8): its OWN control, distinct from
// the board .json Save/Import above. A PURE READ (R2) — it runs reportModel over
// the live state, renders the chosen format, and downloads it. It dispatches
// nothing and never touches the sprintplan:board autosave envelope.
const REPORT_FORMATS = {
  md: { render: toMarkdown, ext: "md", mime: "text/markdown" },
  html: { render: toHtml, ext: "html", mime: "text/html" },
  csv: { render: toCsv, ext: "csv", mime: "text/csv" },
};

function exportReport(/** @type {string | null} */ format) {
  const spec = format ? REPORT_FORMATS[/** @type {keyof typeof REPORT_FORMATS} */ (format)] : undefined;
  if (!spec) return;
  const state = store.getState();
  const text = spec.render(reportModel(state));
  downloadText(text, `${slugify(state.meta.title)}-summary-${todayISO()}.${spec.ext}`, spec.mime);
}

document.querySelectorAll("[data-export]").forEach((btn) =>
  btn.addEventListener("click", () => {
    exportReport(btn.getAttribute("data-export"));
    btn.closest("details")?.removeAttribute("open"); // collapse the menu after a pick
  }),
);

/** @type {{ close: () => void } | null} The open load-time prompt, if any. A
 * successful import closes it; mid-session (no prompt) it stays null. */
let activePrompt = null;

// The single load boundary, shared by file-import and the #7 demo button so both
// run one identical, tested path: extract -> migrate -> validate -> loadPlan.
// ATOMIC (R3): any failure flashes a reason and dispatches nothing. Returns true
// on success so callers can run their own post-steps (prompt close / success
// flash). Banner re-arming is the caller's job (the demo button re-arms; import
// keeps its prior behaviour).
/**
 * @param {unknown} parsed
 * @param {"file" | "restore"} mode
 * @param {string} failPrefix
 * @returns {boolean}
 */
function loadParsedPlan(parsed, mode, failPrefix) {
  const ext = extractPlan(parsed, mode);
  if (!ext.ok) return flash(`${failPrefix}: ${ext.reason}.`), false;
  const mig = migratePlan(ext.plan);
  if (!mig.ok) return flash(`${failPrefix}: ${mig.reason}.`), false;
  const val = validatePlan(mig.plan);
  if (!val.ok) return flash(`${failPrefix}: ${val.reason}.`), false;
  store.dispatch(loadPlan(normalise(val.plan))); // autosaves + repaints for free
  return true;
}

// Import a board file: ATOMIC (R3) — validate fully before any dispatch, so a
// bad or foreign file leaves the current board exactly as it was.
const fileInput = /** @type {HTMLInputElement | null} */ (document.getElementById("board-file"));
document.getElementById("tb-import")?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = ""; // reset first, so the same file can be re-picked later
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return flash("Import failed: that file isn't valid JSON.");
  }
  if (!loadParsedPlan(parsed, "file", "Import failed")) return;
  activePrompt?.close(); // a load-time import closes the prompt; mid-session it is null
  activePrompt = null;
  flash("Board imported.");
});

// --- #7: one-click demo + clear (LOCAL MODE ONLY) --------------------------
// NEW_PLAN / LOAD_PLAN are not room ops, so both controls hide in a room (like
// Collaborate) and are never dispatched there. Each REPLACES the whole plan, so
// when the board holds real work they confirm first; an empty board skips it.

/** A board with no epics and no stories is "empty" — nothing to lose on replace.
 * @param {import("./store.js").PlanState} s */
function isBoardEmpty(s) {
  return Object.keys(s.epics).length === 0 && Object.keys(s.stories).length === 0;
}

/**
 * Run a whole-plan replace, confirming first when the board is non-empty (R3).
 * @param {() => void} run
 * @param {{ heading: string, message: string, confirmLabel: string }} prompt
 */
function replacePlan(run, prompt) {
  if (isBoardEmpty(store.getState())) return run();
  confirmModal({ ...prompt, danger: true, onConfirm: run });
}

// Demo = fetch the bundled sample and run it through the SAME import boundary
// (atomic: a fetch or pipeline failure flashes a reason and changes nothing).
async function loadDemo() {
  let parsed;
  try {
    const res = await fetch("/samples/sample-plan.json");
    if (!res.ok) return flash("Demo load failed: could not fetch the sample.");
    parsed = await res.json();
  } catch {
    return flash("Demo load failed: could not fetch the sample.");
  }
  clearDismissedBanners(); // R4: a whole-plan replace re-arms the per-sprint banners
  if (loadParsedPlan(parsed, "file", "Demo load failed")) flash("Demo plan loaded.");
}

// Clear = the resume prompt's "Start new" path: a fresh plan anchored at today.
function clearPlan() {
  clearDismissedBanners(); // R4
  store.dispatch(newPlan(nextMonday(todayISO())));
  flash("Cleared to a new plan.");
}

const demoBtn = document.getElementById("tb-demo");
const clearBtn = document.getElementById("tb-clear");
if (IN_ROOM) {
  if (demoBtn) demoBtn.hidden = true;
  if (clearBtn) clearBtn.hidden = true;
} else {
  demoBtn?.addEventListener("click", () =>
    replacePlan(() => void loadDemo(), {
      heading: "Load the demo plan?",
      message: "This replaces your current board with the sample plan. Your current work will be lost.",
      confirmLabel: "Load demo",
    }));
  clearBtn?.addEventListener("click", () =>
    replacePlan(clearPlan, {
      heading: "Clear the plan?",
      message: "This clears the board to a fresh, empty plan. Your current work will be lost.",
      confirmLabel: "Clear plan",
    }));
}

// --- Load-time gate: the Resume / New-plan prompt (Screen 3, R1/R2) ---------
// The store already booted fresh and painted an empty board. Now classify the
// saved bytes and, only if a save exists, open the prompt OVER that fresh board.
// Nothing has dispatched yet, so the saved bytes are still intact for rescue.

// Room mode skips the local restore gate entirely (R3): there is nothing local
// to resume, and the authoritative state arrives over the socket.
const verdict = IN_ROOM ? /** @type {SaveVerdict} */ ({ kind: "none" }) : classifySave();

if (verdict.kind === "valid") {
  activePrompt = openResumePrompt(
    { plan: verdict.plan, savedAt: verdict.savedAt, nowISO: nowISO() },
    {
      onResume: () => store.dispatch(loadPlan(verdict.plan)), // already normalised
      onStartNew: () => store.dispatch(newPlan(nextMonday(todayISO()))),
      onImport: () => fileInput?.click(),
      onDownloadCurrent: () => downloadBoard(verdict.plan),
    },
  );
} else if (verdict.kind === "invalid") {
  activePrompt = openInvalidPrompt(
    { reason: verdict.reason },
    {
      onResume: () => {}, // no resume on an invalid save
      onStartNew: () => store.dispatch(newPlan(nextMonday(todayISO()))),
      onImport: () => fileInput?.click(),
      onDownloadRescue: () => downloadRaw(verdict.raw),
    },
  );
} else {
  // First run only (no save): briefly highlight the strip as the edit surface.
  const strip = document.getElementById("settings-strip");
  if (strip) {
    strip.classList.add("is-fresh");
    setTimeout(() => strip.classList.remove("is-fresh"), 5000);
  }
}
