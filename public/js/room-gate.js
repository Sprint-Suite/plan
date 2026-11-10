// @ts-check
/**
 * The #3 name-on-join gate (phase2-build4). A blocking, non-dismissable prompt
 * shown in room mode before the socket opens whenever the joiner has no real
 * name. Returns the entered name; the room boot awaits it. View-only — the pure
 * decision (whether to prompt) is resolveJoinName in room-join.js.
 */

import { el } from "./dom.js";
import { openModal } from "./modal.js";

/**
 * Show the blocking name gate and resolve with a non-empty trimmed name. The
 * modal cannot be dismissed (no Escape, no backdrop, no Cancel); submit is
 * disabled until a non-empty name is typed.
 * @param {string} [heading]
 * @returns {Promise<string>}
 */
export function promptForName(heading = "Join the room") {
  return new Promise((resolve) => {
    const content = el("div", "modal-body");
    content.append(el("p", "field-hint", "Enter your name so everyone in the room can see who's here."));
    const field = el("div", "field");
    field.append(el("label", "label", "Your name"));
    const input = /** @type {HTMLInputElement} */ (el("input", "input"));
    input.type = "text";
    input.placeholder = "e.g. Dave";
    input.setAttribute("aria-label", "Your name");
    field.append(input);
    content.append(field);

    const footer = el("div", "modal-footer");
    const right = el("div", "modal-footer-right");
    const submit = /** @type {HTMLButtonElement} */ (el("button", "btn btn-pri", "Join room"));
    submit.setAttribute("type", "button");
    submit.disabled = true;
    right.append(submit);
    footer.append(right);

    const modal = openModal({ heading, content, footer, dismissable: false });

    const sync = () => { submit.disabled = input.value.trim() === ""; };
    const done = () => {
      const name = input.value.trim();
      if (!name) return;
      modal.close();
      resolve(name);
    };
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(); }
    });
    submit.addEventListener("click", done);
    input.focus();
  });
}

/**
 * Block the board after the room connection drops: the store has stopped
 * sending, so the board on screen is stale. Non-dismissable; Reload rejoins
 * with a fresh authoritative state.
 */
export function showConnectionLost() {
  const content = el("div", "modal-body");
  content.append(el("p", "field-hint", "The connection to this room was lost, so the board may be out of date. Reload to rejoin."));
  const footer = el("div", "modal-footer");
  const right = el("div", "modal-footer-right");
  const reload = /** @type {HTMLButtonElement} */ (el("button", "btn btn-pri", "Reload"));
  reload.setAttribute("type", "button");
  right.append(reload);
  footer.append(right);
  openModal({ heading: "Connection lost", content, footer, dismissable: false });
  reload.addEventListener("click", () => location.reload());
  reload.focus();
}
