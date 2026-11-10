# Debate: Code review: M3 op + document integrity implementation, branch fix/m3-op-document-integrity

- Id: 2026-11-10-code-review-m3-op-document-integrity-implementatio
- Opened: 2026-11-10T11:35:56.720Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

This implements the design we agreed in docs/debates/2026-11-10-design-m3-op-document-integrity-for-sprintplan-roo.md. The range is main..HEAD on fix/m3-op-document-integrity (one code commit plus a docs commit). Do not read data/ or node_modules/.

Files: public/js/plan-contract.js (new; validatePlan moved here and re-exported from plan-io.js), public/js/plan-io.js, server/rooms.js (checkCommand), server/db.js (loadRoom migrates), server/server.js (POST /rooms migrates then validates), bin/audit-rooms.mjs (new), plus tests: tests/plan-contract.test.js, tests/apply-op-rejects.test.js, tests/room-migration.test.js, tests/audit-rooms.test.js, and a one-line assertion change in tests/spike-op-loop.test.js (the reason regex for case 5b now matches the story id, because the new contract rejects the partial story record before it gets to points/epic).

Verification: npm test 302/302; typecheck clean. Every new test was watched failing before its fix. A headless browser smoke drove the real settings UI (duration 1, sprint weeks 4, velocity 33, buffer 15) and reloaded: the state restored via the valid Resume prompt, with no invalid-save prompt and no console errors.

Deliberate choices to challenge:
- Reason strings use label() for possibly non-string ids, so building a message can't throw.
- loadRoom throws on a failed migration. The B1 upgrade catch turns that into a destroyed socket, so the room is unreachable rather than served unvalidated.
- The audit classifies a room as "migrates" by object identity (migratePlan returns the same object at v3).
- MOVE_STORY range checks now exist both as a command check and implicitly via exactly-once. This is per the agreed design. Exactly-once does not see out-of-range indices (the reducer no-ops), so the command check is the only thing catching that case.

Check correctness, any remaining throw paths in validatePlan, compatibility with legitimate saves and single-user flows (any client action whose result now fails the contract?), audit-script safety (it's read-only, and opens with fileMustExist), and test quality.

## Round 1/3 — ChatGPT: OBJECT

The core implementation matches the agreed design, but one reproducible compatibility gap remains: public/js/plan-contract.js:58 caps velocity at Number.MAX_SAFE_INTEGER, while public/js/main.js:365–367 accepts any finite rounded positive number and public/index.html imposes no maximum. Using the shipped handler's coercion, entering 9007199254740992 produces an accepted, autosaved state that validatePlan rejects as 'invalid velocity' after JSON round-trip. Reload therefore presents the invalid-save prompt for a value the application accepted itself. The magnitude is extreme, but this directly violates the requested producer/restore consistency. Enforce the same bound before dispatch, preferably through a shared pure input helper, and add a boundary round-trip regression test.

Otherwise, label() avoids unsafe identifier coercion; the narrow command checks are correct; audit classification by identity matches migratePlan's current behavior; and readonly/fileMustExist plus SELECT-only access protects stored documents. I independently verified legacy load → v3 → edit → persisted v3 using an in-memory database. Contract tests passed 15/15, rejection tests 14/14, typecheck and syntax checks passed, and 768 ordinary settings transitions validated. Full npm test could not pass in this restricted environment because temporary-file writes and socket binding are prohibited; these are verification limits, not demonstrated implementation failures. No files were changed.

## Round 2/3 — Claude

Conceded and fixed in the latest commit on the branch. validate.js now exports MAX_VELOCITY and parseVelocity(input), which rounds, clamps to at least 1, and returns null for blank, non-numeric or above-MAX_VELOCITY input. main.js's #ss-velocity handler dispatches only a non-null parseVelocity result, and plan-contract.js bounds velocity by the same MAX_VELOCITY, so there is one rule with two consumers. Tests watched failing first: parseVelocity's rounding and clamp; refusal of "abc", "" and "9007199254740992"; and a round trip in which every velocity parseVelocity accepts (1, 33, 9007199254740991) survives JSON save/restore through validatePlan. npm test 305/305, typecheck clean, and the headless settings-UI restore smoke still restores via Resume with no invalid prompt.

I kept the bound at MAX_SAFE_INTEGER rather than choosing a product maximum. A real upper bound is a product decision for David, not part of this fix. Settings bufferPct is already clamped 0..99 by the handler, durationMonths and sprintWeeks come from fixed select options, and startDate comes from a date input, so I believe no other settings producer can exceed the contract. Do you agree?

## Round 2/3 — ChatGPT: OBJECT

Commit 94d4f5c resolves the velocity objection. I verified the shared bound, accepted-value round trips, rejection above MAX_SAFE_INTEGER, passing validator tests (22/22), and clean typecheck. Keeping a technical maximum without inventing a product maximum is reasonable.

However, a date input does not enforce the contract's four-digit year limit. HTML permits years with four or more digits ([HTML Standard](https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-date-string)). public/index.html's #ss-start has no maximum, and public/js/main.js:362 dispatches every nonempty value. I reproduced SET_START_DATE with '10000-01-01': the reducer produces seven sprints, but the JSON save/restore round trip fails validatePlan with 'invalid start date', because plan-contract.js:31 requires exactly four year digits. This leaves the same producer/restore inconsistency as velocity.

Guard the start-date handler with the shared isISODate check before dispatch, and add a regression proving unsupported dates leave state unchanged while accepted dates survive save/restore. A native maximum can supplement that guard, but the handler must enforce it. The core M3 implementation otherwise retains my support.

## Round 3/3 — Claude

Conceded and fixed in the latest commit on the branch. isISODate moves from plan-contract.js to validate.js, alongside the other shared field rules. plan-contract.js imports it, and main.js's #ss-start handler now dispatches only when isISODate(v), replacing `v &&`. Tests: isISODate accepts 2026-07-06 and 2028-02-29, and rejects 10000-01-01, 2026-02-30, 2027-02-29, 2026-7-6, "" and null. Every date it accepts (including 9999-12-31) survives a JSON save/restore through validatePlan.

Handler behaviour, verified headlessly in Chromium: setting #ss-start to 10000-01-01 and firing change leaves the saved startDate unchanged; a real date (2027-03-01) is accepted; and the reload restores via Resume. I ran the same script against the previous handler, and it saved 10000-01-01, so the check isn't vacuous. npm test 308/308, typecheck clean.

All settings producers now share the contract's rule: start date via isISODate; velocity via parseVelocity; buffer clamped 0..99 in its handler; duration and sprint weeks from fixed select options within 1..3 and 1..4. Do you agree M3 is complete?

## Round 3/3 — ChatGPT: AGREE

I inspected commit 04765e1 on fix/m3-op-document-integrity. main.js now guards start-date dispatch with the same isISODate function used by plan-contract.js, closing the remaining producer/restore mismatch. The velocity fix remains correct. Field-validation and document-contract tests passed 24/24; typecheck and the latest commit's diff check passed. I have no remaining blocking findings. I could not independently reproduce the full suite or browser smoke because this sandbox prohibits temporary-file writes and socket binding.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Keep the shared reducer and wire protocol unchanged. Enforce the v3 document contract, exactly-once placement, own-property references, dependency integrity and exact generated sprint facts. Apply narrow command guards for epic creation/deletion and story destinations. Share date and velocity rules between settings inputs and document validation. Migrate imported and cold-loaded room documents, persisting upgrades on the next successful operation. Deploy with writes paused, a database backup and the read-only room audit passing with zero invalid rooms.

