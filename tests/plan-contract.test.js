// @ts-check
/**
 * The complete v3 document contract enforced by validatePlan: total (never
 * throws), own-property lookups, every story placed exactly once, and derived
 * data (sprints) equal to what the settings generate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduce } from "../public/js/store.js";
import { ActionTypes, moveStory } from "../public/js/actions.js";
import { validatePlan, migratePlan } from "../public/js/plan-io.js";

const A = ActionTypes;

/** Seven sprints, epic E1, stories a (sprint 1) and d (backlog, no epic). */
function plan() {
  let s = createInitialState("2026-07-06");
  s = reduce(s, { type: A.ADD_EPIC, payload: { id: "E1", title: "One" } });
  s = reduce(s, { type: A.ADD_STORY, payload: { id: "a", title: "A", summary: "", points: 5, epicId: "E1" } });
  s = reduce(s, { type: A.ADD_STORY, payload: { id: "d", title: "D", summary: "", points: 2, epicId: null } });
  return reduce(s, moveStory({ storyId: "a", target: { kind: "sprint", index: 1 }, beforeId: null }));
}

/** @param {(p: any) => void} mutate */
function rejects(mutate) {
  const p = structuredClone(plan());
  mutate(p);
  const r = validatePlan(p);
  assert.equal(r.ok, false);
}

test("baseline plan is valid", () => {
  assert.equal(validatePlan(plan()).ok, true);
});

// --- placement ---------------------------------------------------------------

test("a story placed nowhere (orphan) is rejected", () => rejects((p) => {
  p.backlog = p.backlog.filter((/** @type {string} */ id) => id !== "d");
}));

test("an inherited key used as a placed id is rejected", () => rejects((p) => {
  p.backlog.push("constructor");
}));

test("MOVE_STORY to a non-integer sprint index yields a rejected document", () => {
  for (const index of [0.5, "0"]) {
    const next = reduce(plan(), moveStory({ storyId: "d", target: /** @type {any} */ ({ kind: "sprint", index }), beforeId: null }));
    assert.equal(validatePlan(next).ok, false, `index ${JSON.stringify(index)}`);
  }
});

test("EDIT_STORY on an unknown id yields a rejected document", () => {
  const next = reduce(plan(), { type: A.EDIT_STORY, payload: { id: "ghost", title: "G", summary: "", points: 1, epicId: null } });
  assert.equal(validatePlan(next).ok, false);
});

// --- meta / settings ---------------------------------------------------------

test("meta.title must be a string or null", () => {
  rejects((p) => { p.meta.title = { title: "x" }; });
  const titled = structuredClone(plan());
  titled.meta.title = "Q3";
  assert.equal(validatePlan(titled).ok, true);
});

test("schemaVersion other than 3 is rejected (validatePlan expects a migrated plan)", () => rejects((p) => {
  p.meta.schemaVersion = 2;
}));

test("settings outside the shipped ranges are rejected", () => {
  const bad = [
    ["startDate", "2026-13-40"], ["startDate", "<b>x</b>"], ["startDate", 20260706],
    ["durationMonths", 4], ["durationMonths", 0], ["sprintWeeks", 5], ["sprintWeeks", 1.5],
    ["velocity", 0], ["velocity", "20"], ["bufferPct", 100], ["bufferPct", -1],
  ];
  for (const [key, value] of bad) {
    const p = structuredClone(plan());
    p.settings[key] = value;
    assert.equal(validatePlan(p).ok, false, `${key}=${JSON.stringify(value)}`);
  }
});

// --- sprints must equal what the settings generate ---------------------------

test("sprints that differ from the generated schedule are rejected", () => {
  rejects((p) => { p.sprints.push({ ...p.sprints[6], index: 7, placedStoryIds: [] }); });
  rejects((p) => { p.sprints.pop(); });
  rejects((p) => { p.sprints[2].startDate = "<img src=x>"; });
  rejects((p) => { p.sprints[2].days = 99; });
  rejects((p) => { p.sprints[2].index = 5; });
  rejects((p) => { p.sprints[2].isPartial = true; });
  rejects((p) => { p.sprints[2].name = "Renamed"; });
  rejects((p) => { p.sprints[2].placedStoryIds = [42]; });
});

// --- epics / stories ---------------------------------------------------------

test("epic records must be well-formed", () => {
  rejects((p) => { p.epics.E1.id = "E9"; });
  rejects((p) => { p.epics.E1.title = 7; });
  rejects((p) => { p.epics.E1.colourKey = "red"; });
});

test("story records must be well-formed", () => {
  rejects((p) => { p.stories.d.id = "x"; });
  rejects((p) => { p.stories.d.title = null; });
  rejects((p) => { p.stories.d.summary = 3; });
  rejects((p) => { p.stories.d.stretch = "yes"; });
  rejects((p) => { p.stories.d.epicId = "toString"; });
});

// --- deps / transient --------------------------------------------------------

test("dependency ids must be unique strings", () => {
  rejects((p) => { p.deps = [{ id: 5, blockerId: "a", blockedId: "d" }]; });
  rejects((p) => {
    p.deps = [{ id: "x", blockerId: "a", blockedId: "d" }, { id: "x", blockerId: "d", blockedId: "a" }];
  });
});

test("lastReturnedStoryIds, when present, must be a string array", () => rejects((p) => {
  p.lastReturnedStoryIds = "a";
}));

// --- totality ----------------------------------------------------------------

test("validatePlan never throws on malformed nested values", () => {
  const mutations = [
    (/** @type {any} */ p) => { p.sprints[0] = null; },
    (/** @type {any} */ p) => { p.stories.d = null; },
    (/** @type {any} */ p) => { p.epics.E1 = null; },
    (/** @type {any} */ p) => { p.meta = null; },
    (/** @type {any} */ p) => { p.settings = null; },
    (/** @type {any} */ p) => { p.backlog = [{ toString: null }]; },
    (/** @type {any} */ p) => { p.stories.d.points = { toString: null }; },
    (/** @type {any} */ p) => { p.deps = [{ id: "x", blockerId: { toString: null }, blockedId: "d" }]; },
  ];
  for (const m of mutations) {
    const p = structuredClone(plan());
    m(p);
    assert.doesNotThrow(() => validatePlan(p));
    assert.equal(validatePlan(p).ok, false);
  }
});

test("migratePlan rejects schema versions below 1 without throwing", () => {
  for (const v of [0, -1]) {
    const p = structuredClone(plan());
    p.meta.schemaVersion = v;
    assert.doesNotThrow(() => migratePlan(p));
    assert.equal(migratePlan(p).ok, false);
  }
});
