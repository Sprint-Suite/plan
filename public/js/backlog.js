// @ts-check
/**
 * Backlog panel view. Renders purely from the backlog selectors; collapse state
 * is VIEW state kept here (not in the store). Click targets carry data-act /
 * data-epic / data-story attributes; main.js owns a single delegated listener.
 */

import { el } from "./dom.js";
import { backlogGroups, epicSummary } from "./backlog-selectors.js";
import { depBadges } from "./dep-selectors.js";

/** Collapsed epic ids — view-only, survives re-render. @type {Set<string>} */
const collapsed = new Set();

/** @param {string} epicId */
export function toggleCollapsed(epicId) {
  if (collapsed.has(epicId)) collapsed.delete(epicId);
  else collapsed.add(epicId);
}

/** Sentinel epicId for unparented stories, used by the drag accepts() check. */
export const NO_EPIC = "__none__";

/**
 * One story card — the single card visual, shared by the backlog panel (no dot;
 * the group header carries the colour) and the sprint board (pass `epic` to
 * prepend the colour dot, since placed cards stand alone). Carries the data
 * attributes the delegated click and the dragula accepts()/drop wiring read.
 * @param {{ id: string, title: string, summary: string, points: number, epicId: string | null, stretch?: boolean }} story
 * @param {{ id: string, title: string, colourKey: string } | null} [epic]
 * @param {Array<{ label: string, violation: boolean }>} [badges]  shared D badges (Brief 7)
 */
export function storyCard(story, epic, badges = [], placed = false) {
  const row = el("div", "bl-story");
  row.dataset.act = "edit-story";
  row.dataset.story = story.id;
  row.dataset.epicId = story.epicId ?? NO_EPIC;
  if (epic) {
    const dot = el("span", "epic-dot");
    dot.dataset.epicColour = epic.colourKey;
    row.append(dot);
  }
  row.append(el("span", "bl-story-title", story.title));
  // Shared D badges. The violation flag is carried per badge (Brief 7); Brief 8
  // renders it as the board-side red treatment. A badge (and the card border) go
  // red only when isViolation is true, which by construction needs BOTH endpoints
  // scheduled — so a backlog card's badges are never red (G7/R3), and storyCard
  // stays signature-stable (R2): it reads the flag it is already handed.
  for (const badge of badges) {
    row.append(el("span", "dep-badge mono" + (badge.violation ? " dep-badge--violation" : ""), badge.label));
  }
  if (badges.some((b) => b.violation)) row.classList.add("bl-story--dep-violation");
  // Variable markers (D badges, stretch chip) sit before the points so the points
  // and the action buttons hold a fixed column on every card.
  if (placed && story.stretch) row.append(el("span", "bl-story-stretch-chip mono", "stretch"));
  row.append(el("span", "bl-story-pts mono", String(story.points)));
  // phase2-build3 #9: one-click return-to-backlog, on PLACED (board) cards only.
  // The explicit `placed` flag (not epic-presence, which is unreliable — a No-epic
  // placed card has epic=null too) keeps backlog renders unchanged. Carries its
  // own data-act so the board listener routes it to MOVE_STORY, not edit-story;
  // drag.js excludes it as a drag handle so grabbing it never starts a drag.
  if (placed) {
    // phase2-build6: stretch is a PLACED-only concept. The muted chip (above)
    // reads only when the flag is on; the toggle is always available on a placed card and
    // routes to SET_STORY_STRETCH via the board listener (a stretch story moved
    // back to the backlog keeps the flag in data but renders neither here). Like
    // the return control, drag.js excludes the toggle so tapping it never drags.
    const toggleLabel = story.stretch ? "Unmark stretch goal" : "Mark as stretch goal";
    const toggle = el("button", "bl-story-stretch-toggle" + (story.stretch ? " is-on" : ""), "✦");
    toggle.setAttribute("type", "button");
    toggle.dataset.act = "toggle-stretch";
    toggle.dataset.story = story.id;
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.setAttribute("aria-pressed", story.stretch ? "true" : "false");
    toggle.title = toggleLabel;
    row.append(toggle);

    const ret = el("button", "bl-story-return", "↩");
    ret.setAttribute("type", "button");
    ret.dataset.act = "return-to-backlog";
    ret.dataset.story = story.id;
    ret.setAttribute("aria-label", "Return to backlog");
    ret.title = "Return to backlog";
    row.append(ret);
  }
  return row;
}

/**
 * @param {import("./store.js").PlanState} state
 */
export function renderBacklog(state) {
  const panel = document.getElementById("backlog");
  if (!panel) return;
  panel.replaceChildren();

  const head = el("div", "bl-head");
  head.append(el("span", "bl-title", "Backlog"));
  const addEpicBtn = el("button", "btn btn-pri btn-sm", "+ Epic");
  addEpicBtn.dataset.act = "add-epic";
  head.append(addEpicBtn);
  panel.append(head);

  const groups = backlogGroups(state);
  if (groups.length === 0) {
    const empty = el("div", "bl-empty");
    empty.append(el("p", "bl-empty-msg", "No epics yet."));
    empty.append(el("p", "bl-empty-sub", "Create your first epic to start building the backlog."));
    panel.append(empty);
    return;
  }

  for (const group of groups) {
    const epic = group.epic;
    const key = epic ? epic.id : "__none__";
    const isCollapsed = collapsed.has(key);

    const section = el("section", "bl-group");
    const groupHead = el("div", "bl-group-head");

    const chevron = el("button", "bl-chevron", isCollapsed ? "▸" : "▾");
    chevron.dataset.act = "toggle-epic";
    chevron.dataset.epic = key;
    groupHead.append(chevron);

    if (epic) {
      const dot = el("span", "epic-dot");
      dot.dataset.epicColour = epic.colourKey;
      groupHead.append(dot);
      const title = el("span", "epic-title", epic.title);
      title.dataset.act = "edit-epic";
      title.dataset.epic = epic.id;
      groupHead.append(title);
      const sum = epicSummary(state, epic.id);
      groupHead.append(el("span", "bl-meta mono", `${sum.unplacedCount} stories · ${sum.unplacedPoints} pts`));
    } else {
      groupHead.append(el("span", "epic-title epic-title-none", "No epic"));
      const pts = group.stories.reduce((t, s) => t + s.points, 0);
      groupHead.append(el("span", "bl-meta mono", `${group.stories.length} stories · ${pts} pts`));
    }
    section.append(groupHead);

    if (!isCollapsed) {
      const body = el("div", "bl-stories");
      // This container is a dragula drop target; accepts() refuses any card
      // whose epicId differs from this group's, so a drag never reparents.
      body.dataset.drop = "backlog";
      body.dataset.epicId = epic ? epic.id : NO_EPIC;
      for (const story of group.stories) body.append(storyCard(story, null, depBadges(state, story.id)));
      const addStory = el("button", "bl-add-story", "+ Story");
      addStory.dataset.act = "add-story";
      if (epic) addStory.dataset.epic = epic.id;
      body.append(addStory);
      section.append(body);
    }

    panel.append(section);
  }
}
