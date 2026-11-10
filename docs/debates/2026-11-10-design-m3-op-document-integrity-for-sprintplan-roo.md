# Debate: Design: M3 op + document integrity for sprintplan rooms (validatePlan completeness, exactly-once placement, per-op checks)

- Id: 2026-11-10-design-m3-op-document-integrity-for-sprintplan-roo
- Opened: 2026-11-10T11:25:36.035Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

Context: main f7d87d9 (B1/B2 merged and deployed). M3 from our agreed review: MOVE_STORY with sprint index 0.5 or "0" removes a story from every array (store.js:113); EDIT_STORY on an unknown id creates an unplaced orphan; validatePlan uses `in` (inherited keys like "constructor" pass); validatePlan can throw on null nested entries and accepts an object-valued meta.title; migratePlan throws for schemaVersion 0/-1. Do not read data/ or node_modules/.

Constraint: validatePlan is the shared load boundary. Single-user localStorage restore, file import, POST /rooms import, and the server's applyOp (which validates the NEXT document after reduce) all use it. A failed restore shows the "invalid save" prompt with the raw data, so a stricter validator does not silently lose local work. But any live room whose stored doc already violates a new rule would reject EVERY subsequent op.

Proposal: ONE control at the document level, not a parallel per-op validator.
1. validatePlan becomes complete and total (never throws, own-property checks only):
   - meta {title: string|null, schemaVersion: 3}
   - settings {startDate: valid ISO YYYY-MM-DD; durationMonths int 1..24; sprintWeeks int 1..4; velocity int >= 1; bufferPct int 0..99}
   - sprints: array of objects, length === generateSprints(settings).length; each has name string, ISO startDate/endDate, placedStoryIds string[]
   - epics: own keys; value object, id === key, title string, colourKey in PALETTE
   - stories: own keys; value object, id === key, title string, summary string, points valid, epicId null or own epic key, stretch absent or boolean
   - backlog: string[]
   - EXACTLY-ONCE: every story key appears in exactly one of backlog/placedStoryIds, and every placed id is an own story key
   - deps: objects with unique string id; blocker/blocked are distinct own story keys; no duplicate directed pair (stays directional, a standing ruling)
   - lastReturnedStoryIds: string[] if present
2. migratePlan rejects schemaVersion < 1.
3. Reducer and wire protocol unchanged (standing ruling: multiplayer reuses the shipped reducer by import). Exactly-once alone rejects BOTH live bugs: a bad MOVE_STORY index leaves the story unplaced, and an EDIT_STORY on an unknown id creates an unplaced story. A bad target.kind falls to the sprint branch, matches nothing, and is rejected the same way.
4. Per-op checks ONLY where the next document is valid but the op is still wrong. My enumeration of that set: ADD_EPIC with an existing epic id (silently replaces title and colour); ADD_STORY with an existing id (caught by exactly-once via the duplicate backlog entry); LINK_DEP with an existing dep id (caught by dep-id uniqueness). So the only server per-op rule is "ADD_EPIC must use a fresh id", in applyOp.
5. Rollout: before deploy, a read-only query on the box runs the new validatePlan over every stored room and reports any failures. If any fail, a one-off repair puts orphans at the end of the backlog, rather than adding a lenient rule to the validator.

Why not a full per-op validator: two controls guarding the same invariant can't each be proven, because removing either leaves the tests green. The document is what gets persisted and broadcast, so the document is where the invariant lives.

Challenge it: is there an op whose resulting document passes this validatePlan but which is still wrong (destination semantics, edit vs create)? Are any of these rules too strict for legitimate older saves (e.g. requiring sprint count to equal generateSprints, or the duration/sprintWeeks bounds)? Is the rollout safe?

## Round 1/3 — ChatGPT: OBJECT

The stronger document boundary is sound, but the per-op enumeration is incomplete. I inspected main f7d87d9 and reproduced these counterexamples:

1. MOVE_STORY with target {kind:"typo", index:0} moves an existing story into sprint 0. store.js:120–126 treats every non-backlog kind as a sprint destination and matches the numeric index. The resulting document satisfies every proposed rule, including exactly-once placement. The claim that a bad kind necessarily matches nothing is incorrect.

2. DELETE_EPIC with mode omitted or "typo" deletes the epic AND its children. store.js:150–178 treats every non-"reparent" mode as "delete". The resulting document is completely valid. A document validator cannot distinguish this malformed destructive command from an intentional deletion.

Therefore, retain the shared reducer and document validator, but add narrowly scoped command checks in server/rooms.js: ADD_EPIC requires a fresh own id; MOVE_STORY requires a recognized destination kind and, for sprints, an integer index within bounds; DELETE_EPIC requires mode "reparent" or "delete". Preserve the documented insertBefore fallback when beforeId is absent from the destination (store.js:88–99).

The proposed validator also remains incomplete. Sprint index, days and isPartial are omitted. render.js:90–95 and :138 use index for totals, layout and drag destinations; plan-maths.js:58–61 uses days/isPartial for capacity. A document containing only the proposed sprint fields passes your specification but renders incorrectly; malformed partial-sprint days produces NaN capacity. Validate index against array position and validate dates, days and isPartial against generateSprints(settings). Matching only sprint count permits inconsistent schedules and capacity facts.

The settings bounds largely match shipped input handling: sprint weeks 1–4, positive integer velocity and buffer 0–99 (index.html:98–114; main.js:362–371). Duration 1–24 is an unexplained expansion: README.md, index.html:90–94 and the spec support 1–3. Use the supported range unless there is an explicit compatibility requirement. I found no conflict between generated sprint counts and the shipped creation/regeneration paths, but retain migration and sample compatibility tests.

Rollout needs a final audit with writes paused. Otherwise the old service can introduce another orphan after the scan. Back up, classify every failure, migrate older schemas where appropriate, repair only understood cases, revalidate all rooms, then restart with the stricter validator. Appending orphans alone cannot repair invalid titles, duplicate placements, malformed stories or inconsistent sprint facts. server/db.js:61–70 loads documents without migration, and server/server.js:125–135 caches them, so schema upgrades and repairs must also reach the loaded state.

Document integrity and command semantics are distinct testable contracts. Add rejection tests for the counterexamples above that assert unchanged document, version and persistence. Also change tests/apply-op-rejects.test.js's commit-failure fixture to send a valid string title; its current object payload would now fail validation before exercising commit failure. Five targeted existing test files passed; no repository changes were made.

## Round 2/3 — Claude

Conceded on every point. Revised design:

A. Document contract (validatePlan: total, never throws, own-property checks only). Everything from my proposal, plus:
- sprints must equal generateSprints(settings) element by element on index (== array position), name, startDate, endDate, days and isPartial, and each sprint's placedStoryIds is a string[]. The full schedule is derived data, so it must match exactly, not just by count.
- durationMonths int 1..3 (the shipped range), not 1..24.
- migratePlan rejects schemaVersion < 1.

B. Command contract (server/rooms.js, before reduce), only for commands whose resulting document can be valid but wrong:
- ADD_EPIC: id is a string and not an existing own epic key.
- MOVE_STORY: target.kind is "backlog" or "sprint"; for a sprint, Number.isInteger(index) and 0 <= index < sprints.length. The insertBefore fallback for an absent beforeId is unchanged.
- DELETE_EPIC: mode is "reparent" or "delete".
Each gets a rejection test asserting unchanged doc, in-memory version and persisted version. The exactly-once and unknown-id cases get document-level tests. Reducer and wire are untouched. The commit-failure fixture moves to a valid string title.

C. Rollout, with writes paused:
1. Stop sprintplan-rooms.
2. Back up rooms.db.
3. Run a read-only audit script (bin/audit-rooms.mjs, opens the db readonly) that does migratePlan + validatePlan per room and prints room id + reason, and no document content.
4. If everything passes, deploy and start. If anything fails, it stays stopped and I bring you the classified failures. Repair only understood cases with a reviewed one-off, then re-audit to all-pass before starting.
5. POST /rooms will also run migratePlan before validatePlan, so an imported older plan is stored at v3. That isn't the case today.
Loaded rooms are cached only in-process, so a restart after the repair clears any stale cache.

Agree?

## Round 2/3 — ChatGPT: OBJECT

The revision addresses my previous counterexamples, but two concrete gaps remain.

1. DELETE_EPIC also needs an id type check. I reproduced DELETE_EPIC {id:null, mode:"delete"} against a valid plan containing an unparented story. store.js:163–164 selects every story whose epicId equals null, then deletes them all. No epic needs to exist. The resulting document satisfies your complete contract and exactly-once placement. Require typeof payload.id === "string" before reduction, alongside the mode check. Add a rejection test with unparented stories, asserting unchanged document and both versions. This can preserve the existing harmless no-op behavior for unknown string ids.

2. The read-only audit can report success while leaving stored rooms incompatible. migratePlan returns a new document; it does not update storage (plan-io.js:105–123). loadRoom still reads the original JSON without migration (server/db.js:61–70). Consequently, a valid stored v2 room passes migratePlan + validatePlan during audit, but loads as v2 after restart. Subsequent operations preserve schemaVersion 2 and fail the new validator. Updating POST /rooms only fixes newly imported rooms.

Have the auditor distinguish 'already valid at v3' from 'valid after migration, requires upgrade'. While the service remains stopped, persist required upgrades through a reviewed transactional step, then run validatePlan directly against every stored document before permitting startup. A restart clears the cache but cannot upgrade the stored JSON. Test this with a legacy room that is upgraded, cold-loaded, and successfully edited afterward.

I support the revised document contract, unchanged reducer/wire, narrow command checks, and paused-write rollout once these two gaps are closed. Repository remains unchanged at f7d87d9; both findings were checked with in-memory reproductions.

## Round 3/3 — Claude

Both conceded.

1. DELETE_EPIC: typeof payload.id === "string" is required alongside the mode check. Rejection test: a plan with unparented stories, {id:null, mode:"delete"}, asserting an unchanged doc, in-memory version and persisted version. An unknown string id keeps its existing harmless no-op.

2. Upgrading stored rooms: I'll do it in loadRoom itself rather than as a one-off upgrade step. db.js loadRoom runs migratePlan on the parsed JSON (a failure throws, and B1's upgrade catch turns that into a refused socket). Every cold load is then v3 in memory, and the first committed op persists v3. This is the same single migration seam every other load path already uses (restore, file import, and now POST /rooms), so rooms stop being the one path that skips it. It also covers any legacy row written later, not just the rows present at deploy. The auditor classifies each room as valid-at-v3, valid-after-migration (served correctly through loadRoom) or invalid, and startup waits on zero invalid. Regression test: seed a v2 row directly via SQL, cold-load it through the server, apply an EDIT_STORY, and assert ok:true and that the persisted row is now schemaVersion 3.

If you'd still rather have the stored JSON upgraded before startup, say why. Otherwise I believe we agree on A (document contract), B (command checks for ADD_EPIC, MOVE_STORY and DELETE_EPIC including id type) and C (paused-write audit, with migration in loadRoom).

## Round 3/3 — ChatGPT: AGREE

Migration in loadRoom resolves my rollout objection. server/server.js:130–135 caches the loaded document and :205–209 sends it as the authoritative snapshot, so migrating before return gives clients v3 immediately. server/rooms.js:65–77 then reduces and persists that migrated document on the first successful operation. The upgrade catch at server/server.js:166–171 contains migration failures. I checked this migration/edit sequence in memory; eager database rewriting is unnecessary. The DELETE_EPIC string-id check also closes the reproduced null-id deletion bug.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Keep the reducer and wire protocol unchanged. Make validatePlan total, use own-property checks, enforce the complete v3 document contract, exactly-once story placement, directed dependency uniqueness, shipped settings bounds and exact generated sprint facts. Reject schema versions below 1. Before reduction, enforce fresh string ids for ADD_EPIC, valid destination kinds and bounded integer sprint indices for MOVE_STORY, and string ids plus recognized modes for DELETE_EPIC. Preserve documented placement fallbacks and harmless unknown-string deletion behavior. Migrate imported plans in POST /rooms and stored plans in loadRoom; persist migrated room documents on their next successful operation. Deploy with the room service stopped, a database backup and a read-only audit that classifies migration needs and blocks startup on invalid documents. Include rejection atomicity tests, the corrected commit-failure fixture, and a SQL-seeded legacy-room regression verifying the initial v3 snapshot, successful edit and persisted v3 document.

