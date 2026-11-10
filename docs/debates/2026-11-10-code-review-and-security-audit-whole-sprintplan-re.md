# Debate: Code review and security audit: whole sprintplan repo at main f7409e2 (code quality, security, improvements)

- Id: 2026-11-10-code-review-and-security-audit-whole-sprintplan-re
- Opened: 2026-11-10T10:48:51.751Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

Scope: full repo at main f7409e2 (sprintplan.uk: static single-user planning board in public/, plus a Node ws "rooms" multiplayer service in server/ behind apache). Please do NOT read data/ (local sqlite session DB) or node_modules/. Check correctness, auth/access control, input handling, injection, secrets, error paths. Here are my findings, ranked; challenge any you think are wrong or mis-ranked, and add what I missed.

MAJOR
1. Entitlement never enforced. @suite/auth-client creates a plan session for ANY hub user who hits sprintsuite.uk/launch/plan (hub routes/launch.js mints tokens with no entitlement check; exchange returns entitled:false rather than refusing). plan never reads `entitled`: decideUpgrade (server/server.js:38) checks only company, POST /rooms uses requireAuth (no entitlement check), and /auth/whoami returns authed:true regardless. So a non-entitled hub user gets the single-user board, can create rooms (if they have a company), and joins company-only rooms of their company. Fix: reject !session.entitled in decideUpgrade's company-only branch and in POST /rooms; client gate should treat authed-but-unentitled as redirect (needs whoami to expose it, or a plan-side endpoint).
2. Unbounded input on the ws op path = DoS by any open-link token holder. WebSocketServer has no maxPayload (ws default 100 MiB); validatePlan has no string-length or count limits (I verified a 5 MB story title is accepted by applyOp); every op re-serialises and rewrites the whole doc to sqlite and broadcasts. No per-socket rate limit. Fix: maxPayload ~64 KB, field length caps + story/epic count caps in validatePlan, simple per-socket op rate limit.
3. Error paths can crash the process. The `upgrade` handler is async with no try/catch (provider.verifySession rejection or JSON.parse of a corrupt row in loadRoom -> unhandled rejection -> Node 20 exits). Inside ws 'message', commitRoom (sqlite throw, e.g. SQLITE_BUSY/disk full) is uncaught -> process crash, kicking every room. systemd Restart=always masks it but drops all sessions.

MEDIUM
4. EDIT_STORY on an unknown id succeeds (verified): rooms.js merges onto undefined and reduce creates an orphan story not in any array; validatePlan only checks placed ids exist, not that every story is placed. Ids "__proto__"/"constructor" are accepted and persisted as own keys. Also validatePlan uses `id in plan.stories`, so an imported plan with backlog ["constructor"] passes validation (verified) -> inherited function treated as a story on render (client crash / room poisoning via POST /rooms import). Fix: Object.hasOwn everywhere; EDIT_STORY rejects unknown ids; validatePlan rejects unplaced stories.
5. No Origin check on the ws upgrade. Mitigated by SameSite=Lax on plan_session (cross-site ws handshakes don't carry Lax cookies) and unguessable room ids, but it's cheap defence in depth: allow-list https://sprintplan.uk.
6. Share token entropy: newId() is ~47 bits (two uint32 base36, sliced to 10 chars) and is the sole credential for open-link rooms; also travels in the query string -> apache access logs and Referer (Referrer-Policy strict-origin-when-cross-origin limits the latter). Use 128-bit randomBytes for shareToken; compare with timingSafeEqual (minor).
7. Gate fails open on misconfig: if .env.rooms loses HUB_BASE_URL, server silently uses the STUB provider, whoami 404s, client classifies 404 as "no-auth-system" and shows the board. Fix: start.js should refuse to start in production without HUB_BASE_URL (NODE_ENV or explicit STUB_AUTH=1 opt-in).
8. Memory: `rooms` Map and `sockets` Map never evict (empty sets/room docs stay resident for process lifetime).
9. Self-asserted `name` from query string unbounded; open-link "claimed" identities can impersonate names (UI does mark claimed vs verified - please check presence rendering).

CODE QUALITY
10. Production code still named/commented as spike: startSpikeServer, db.js header "Throwaway spike code", x-spike-session header in auth-seam.
11. The org code-quality standard is not wired (no eslint standards config, no coverage). public/js/main.js is 756 lines (limit 400) and is a god module; plan.css 1310 lines. Comment density 30-60% in server files (budget 25%), heavy with ticket/round references (MP3 R4, phase2-build5 R3) that belong in docs.
12. Dependencies on caret ranges, not pinned; npm audit --omit=dev reports proxy-addr (critical, IP spoofing via trust proxy — we don't set trust proxy so low practical impact), body-parser (high, DoS), qs (moderate) — all fixed by `npm audit fix` within express 4.
13. systemd unit: only NoNewPrivileges; add ProtectSystem=strict, ReadWritePaths=/var/www/plan/data, PrivateTmp, ProtectHome etc. CI runs on node 20 matching box; CI checks out suite@main unpinned.
14. Positives: DOM built via textContent (no innerHTML of data), op allow-list + validate-before-commit is sound, company scoping from session not client, security headers + CSP script-src 'self', 254 tests green, typecheck in CI.

Question for you: do you agree with the severity ranking, especially that #1 is Major (I argue yes: the hub tile is advertised as entitlement-gated), and what did I miss?

## Round 1/3 — ChatGPT: OBJECT

I agree that #2 and #3 are Major, but I dispute #1 as stated and would raise part of #12. I independently inspected main f7409e2, relevant tests, deployment files, and the companion Suite source without reading data/ or node_modules/.

1. Entitlement: the available evidence contradicts the claimed policy. The approved Plan access design explicitly requires a Suite session, describes the single-user gate as a product funnel, and preserves the existing company-only policy. More decisively, the local Suite checkout, c2627ac, declares Plan open:true in [apps.js](/var/www/suite/hub/lib/apps.js:44); [resolveEntitlement](/var/www/suite/hub/lib/entitlements.js:99) returns entitled:true for open apps. This does not prove production matches that checkout, but it defeats the assertion that missing entitlement enforcement is necessarily a Major vulnerability. If David requires a separate Plan grant, enforcing it becomes necessary; that would be a policy change relative to this evidence.

2. Process crashes deserve first priority. Beyond the exceptional failures you identified, an admitted client can send the valid JSON message null: parsing succeeds, then [server/server.js](/var/www/plan/server/server.js:213) dereferences msg.type outside any catch. I reproduced that against the extracted, unchanged callback. I also exercised applyOp with persistence stubbed: an object-valued op type or epicId containing toString:null throws outside the reducer catch. There are no per-WebSocket error listeners either. Validate the message envelope and operation payload before use, catch upgrade failures, and contain persistence failures. Adding maxPayload must be accompanied by error handling.

3. The dependency issue is partly Major, not merely housekeeping. package-lock.json resolves body-parser 1.20.5, while express.json() runs before authentication. The upstream [compressed-body advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828) describes a single unauthenticated request terminating the process and fixes it in 1.20.9. That attack surface outranks comments and configuration hardening. Conversely, caret ranges alone are not a reproducibility defect: this repository commits a lockfile and CI uses [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/). The unversioned, separately installed auth-client is the more concrete reproducibility gap. My npm audit request failed with DNS EAI_AGAIN, so I cannot confirm your complete audit totals or that one audit-fix invocation resolves everything.

4. Validation has additional integrity failures. In [moveStory](/var/www/plan/public/js/store.js:113), sprint indexes 0.5 and "0" pass the bounds check, remove the story from its current array, and match no destination. I reproduced both; validatePlan returns ok:true. Exercising actual applyOp with a persistence stub also confirmed it reaches commit. Require a known target kind and integer index, plus exactly one placement for every story. Your unknown EDIT_STORY and inherited-key findings are correct. However, accepted constructor/__proto__ keys alone do not establish global prototype pollution; describe the demonstrated lookup and integrity failures precisely.

5. validatePlan is neither complete nor reliably non-throwing. Null sprint/story entries throw; empty settings and epics without identities pass. migratePlan throws for schema versions 0 and -1. Validate nested shapes, identifiers, dates, settings, schema versions, and scalar types, alongside lengths and collection counts. Object.hasOwn is necessary but insufficient.

6. Two missed export injection paths merit Medium findings. [csvField](/var/www/plan/public/js/report.js:143) only performs CSV syntax escaping: a story titled =1+1 exports unchanged into a spreadsheet formula cell. Also, [toHtml](/var/www/plan/public/js/report.js:276) interpolates unchecked date fields directly into HTML. I confirmed that a plan with an HTML payload in settings.startDate passes validation and retains that markup in the generated report. This concerns opening the exported document; it is not evidence of script execution inside the live board. Neutralize spreadsheet formulas and escape every HTML substitution.

7. Presence has a stronger identity problem than #9 suggests. The server always takes name from the query string, including for authenticated users. A same-company user can choose another member’s name and receive identity:'verified'; renderPresence then omits the guest marker. Derive a verified display name from trusted session data, or make clear that only company membership is verified. Guests are visibly marked in the presence strip, although cursor labels show names alone.

8. Expand the resource limits beyond operations. Cursor broadcasts, connections, presence fan-out, room creation, total document size, and outbound buffering also need bounds. A per-socket operation limiter does not constrain multiple sockets or slow readers. The [ws documentation](https://raw.githubusercontent.com/websockets/ws/master/doc/ws.md) confirms the 100 MiB default payload limit. Cache eviction is useful, but cannot replace these controls.

9. Additional Medium correctness/access issues: company-only sockets are authenticated only at upgrade, so session invalidation does not revoke an existing connection. The sync client also never consumes its onOpen/onClose hooks: it permits sends before readiness and provides no disconnected state or recovery. Define revocation timing, disable editing until the authoritative snapshot arrives, and visibly handle disconnection.

Origin checks, stronger share tokens, explicit production auth configuration, cache eviction, and systemd hardening are reasonable improvements. Missing HUB_BASE_URL opens the client funnel but also prevents normal authenticated company-room access; it does not itself grant anonymous company-room access. Fixed comment-density and file-length budgets need an applicable standard before being treated as violations. CI typechecking currently covers only public/js, excluding the server boundary where the most serious failures occur.

Verification: six selected test files passed, as did git diff --check; adversarial probes exposed gaps those tests miss. I did not reproduce the claimed full 254-test baseline. No files changed, no commit or push was made, and no server process was started or stopped.

## Round 2/3 — Claude

Concessions and verification:

- #1 CONCEDED. Suite apps.js marks plan `open: true` (suite c2627ac, PR #12 "plan open to signed-in users"), and resolveEntitlement returns entitled:true for open apps. Not entitlement-gated by design. I'm downgrading it to a Low note: plan ignores `entitled` entirely, so if plan is ever moved to grant-only on the hub, plan will not enforce it. The hub's own SessionStart policy is what applies today.
- Your null-frame crash: REPRODUCED end-to-end against the real startSpikeServer with an open-link seeded room. One `null` text frame from any token holder terminates the Node process (TypeError at msg.type, propagated out of ws Receiver). I now rank this the single top finding: BLOCKER, a one-frame remote kill of every room.
- moveStory 0.5 / "0": confirmed by reading store.js:113-127 — the bounds check passes non-integers and strings, removeIdFromArrays drops the story, no sprint index matches, validatePlan doesn't require each story to be placed. Silent loss of a story from the board by any link holder. Major (integrity).
- body-parser compressed-body crash before auth: agreed, raise to Major alongside the null-frame crash (same class: unauthenticated/low-privilege process kill). Fix is the lockfile bump (npm audit fix within express 4).
- CSV formula injection and unescaped startDate/endDate in toHtml: agreed, Medium. tsconfig includes only public/js/**: agreed, server/ is untypechecked; Medium quality.
- Verified-identity name from query string: agreed, merging into my #9 and raising to Medium (a same-company user can display as another member with no guest marker).
- Upgrade-only auth (no revocation of open sockets), sync client sends before snapshot / no disconnected state: agreed, Medium.
- Comment density / file length: agreed these are not violations of a wired standard in this repo; I'll report them as advisory, with the note that the org standard is not wired here.
- Caret ranges: agreed, lockfile + npm ci makes that a non-issue; the unversioned --no-save @suite/auth-client install is the real reproducibility gap.

Proposed final ranking:
BLOCKER: B1 null/malformed ws frame kills the process (plus no envelope validation, no per-socket error listener, async upgrade without catch, uncaught commitRoom throw).
MAJOR: M1 body-parser pre-auth crash (dependency bump). M2 unbounded resources: no maxPayload (100 MiB default), no field/count/doc-size caps (5 MB title verified accepted), no rate limits on ops/cursors/connections/room creation, no backpressure. M3 op integrity: moveStory non-integer index loses stories; EDIT_STORY on unknown id creates orphans; `in` instead of Object.hasOwn; validatePlan not non-throwing and not complete (nested shapes, placement-exactly-once, dates, schema versions).
MEDIUM: CSV formula injection; unescaped dates in HTML export; verified-name spoofing; no ws Origin allow-list; ~47-bit share token in query string; stub-auth silent fallback when HUB_BASE_URL missing; sockets not revoked on session expiry; sync client readiness/disconnect handling; server/ excluded from typecheck; unpinned out-of-band auth-client install.
LOW / quality: plan ignores `entitled`; room/socket Map never evicted; spike naming in prod code; systemd hardening; CI pins suite@main; main.js 756 lines god module; standard not wired; comment density with ticket references.

Do you agree with this ranking? If you still object to any placement, name it.

## Round 2/3 — ChatGPT: OBJECT

The substantive findings now align. I have two remaining classification objections.

1. Promote M1 to BLOCKER alongside B1. The locked body-parser 1.20.5 is covered by the upstream [compressed-body crash advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828), and express.json() executes before authentication in [server/server.js](/var/www/plan/server/server.js:87). If a repeatable whole-service kill warrants BLOCKER, the pre-auth variant warrants the same release priority as the token-holder variant. I independently verified the version and middleware placement; I have not reproduced this dependency exploit end-to-end. Remediation acceptance should verify the resulting lockfile contains a patched version and regression-test the compressed-request path, rather than assume npm audit fix succeeded.

2. Remove 'ignores entitled' from active vulnerability findings. Record it as a future policy dependency: if David changes Plan from open access for signed-in users to grant-controlled access, enforcement must change with it. [Suite apps.js](/var/www/suite/hub/lib/apps.js:44) explicitly declares the current policy. Correct behavior under today's policy is not a Low vulnerability merely because tomorrow's policy could differ.

I accept the remaining placements as practical priorities, with these qualifications: missing Origin validation is defense in depth under the stated cookie configuration; stub fallback is a production configuration/product-access defect, not a demonstrated anonymous bypass of company-room authorization; and cache eviction belongs within M2's resource-management remediation even if separately listed as Low housekeeping.

M3 should explicitly require operation-specific payload validation as well as document validation. Validating only the resulting document cannot reliably reject malformed commands, distinguish edits from unintended creation, or enforce destination semantics.

The repository remains at f7409e2; this round made no changes.

## Round 3/3 — Claude

Both conceded.
1. M1 promoted to BLOCKER (B2): pre-auth body-parser crash on the locked 1.20.5, same release priority as B1. Acceptance criterion recorded as you state it: lockfile shows a patched body-parser (>=1.20.9 per the advisory) AND a regression test sends a malformed compressed body and asserts the process survives; npm audit fix is not itself evidence.
2. "Ignores entitled" removed from findings; recorded as a policy dependency: if Plan moves from open-to-signed-in to grant-controlled on the hub, decideUpgrade / POST /rooms / the entry gate must start enforcing `entitled` in the same change.
Qualifications accepted: Origin check is defence in depth; stub fallback is a config/product-access defect, not a company-room bypass; cache eviction folds into M2. M3 now explicitly requires per-op payload validation (types, known ids, integer in-range indices, edit-vs-create distinction) in addition to whole-document validation.
Final: BLOCKER B1 (malformed ws frame kills process), B2 (pre-auth body-parser crash). MAJOR M2 (unbounded resources incl. eviction), M3 (op + document integrity). Mediums and Lows as previously listed minus the entitlement item. Do you agree?

## Round 3/3 — ChatGPT: AGREE

The revised ranking matches the demonstrated impact and current access policy. Both process-kill paths warrant release-blocking priority; resource exhaustion and accepted operations that corrupt board state are Major. The qualifications correctly distinguish demonstrated authorization failures from defense in depth and configuration defects.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Block release on B1 and B2: contain malformed WebSocket messages and boundary errors, update the locked body-parser to a patched version, and verify process survival with regression tests. Address M2 through payload, document, rate, connection and outbound-buffer limits plus cache eviction. Address M3 through operation-specific validation and complete, non-throwing document validation, including exactly-once story placement. Retain the revised Medium and Low findings. Entitlement enforcement is a future policy dependency, not a current vulnerability. A successful update command alone does not establish remediation.

