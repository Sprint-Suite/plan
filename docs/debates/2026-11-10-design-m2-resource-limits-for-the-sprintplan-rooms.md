# Debate: Design: M2 resource limits for the sprintplan rooms service

- Id: 2026-11-10-design-m2-resource-limits-for-the-sprintplan-rooms
- Opened: 2026-11-10T12:11:30.884Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

Context: main b9ba740 (B1/B2 and M3 deployed). M2 from our agreed review: no ws maxPayload (100 MiB default); no doc-size, count or field caps; no rate limits on ops, cursors, connections or room creation; no handling of slow readers; the rooms and sockets Maps never evict. Do not read data/ or node_modules/. Measured: the shipped 34-story sample plan is 9.4 KB (~280 B/story); longest title 33 chars, longest summary 95.

Principle: bound each resource once, at the server, and leave single-user untouched. Single-user state lives in localStorage and never reaches the server unless imported into a room, so a limit inside validatePlan would create the producer/restore mismatch we fixed in M3 (the UI accepts it, then restore refuses it) for no server benefit. Limits therefore live in a server module, not in validatePlan.

Proposal (server/limits.js holds the constants):
1. Frames: WebSocketServer maxPayload 64 KiB (ops are far smaller). ws closes an oversized frame with 1009.
2. Document size: MAX_DOC_BYTES = 1 MiB (about 3,500 sample-sized stories). applyOp already serialises the effective payload before commit; it would also check JSON.stringify(next).length <= MAX_DOC_BYTES and reject "the plan is too large". POST /rooms applies the same cap to an imported plan. I'm deliberately not adding per-field or per-collection caps: the doc cap is the one control on the resource (memory, sqlite row, state frame, broadcast). A long title is a UX matter, not a resource one. A count cap would be a second guard on the same resource.
3. Body parsing: drop the global express.json(). Mount express.json({ limit: "1mb" }) on POST /rooms only, AFTER provider.requireAuth (the auth-client handlers never read req.body). Nothing parses a body before authentication any more.
4. Rates, per socket (token bucket): ops 20/s with burst 40. Over the limit, the op is nacked "too many changes, slow down" and not applied. Cursors 30/s; over the limit they're dropped silently (ephemeral).
5. Connections: at most 50 sockets per room. Beyond that the upgrade is refused with 503 "Room Full", which also bounds the presence fan-out. I'm not capping per-IP connections: behind apache every peer is 127.0.0.1, and trusting X-Forwarded-For is a separate decision.
6. Room creation: per authenticated user, 20 rooms per rolling hour, in memory. Beyond that, 429.
7. Slow readers: in broadcast/broadcastExcept, a socket whose bufferedAmount exceeds 1 MiB is terminate()d instead of sent to. Its client reconnects and gets a fresh state frame.
8. Eviction: when a room's last socket closes, delete both its sockets entry and its cached room. The next join cold-loads it (migrated) from sqlite.
9. The self-asserted `name` from the query string is trimmed and capped at 40 chars server-side before it enters presence.

Tests (child-process where a crash or limit matters): an oversized frame closes only that socket and the service stays alive; an op that would push the doc over the cap is rejected, with doc, version and persisted row unchanged; a burst of ops past the bucket is nacked and the later ones accepted after refill (with an injectable clock); the 51st socket is refused; the 21st room creation in an hour gets 429; a slow-reader socket is terminated; the cache entry is dropped after the last leave and the room reloads correctly; name capped at 40.

Challenge: are any limits wrong for legitimate use (e.g. ops 20/s for a fast drag sequence or an EDIT_STORY typed burst; check how often the client sends)? Is doc-only capping enough, or is there a real resource a field/count cap protects that the doc cap doesn't? And is route-level JSON parsing safe for the auth-client routes?

## Round 1/3 — ChatGPT: OBJECT

The direction is sound, but several limits leave concrete gaps. I inspected the repository at b9ba740 on fix/m2-resource-limits and ran the four contract, sync-client, cursors and move test files successfully.

The proposed op rate looks generous: drag.js sends one MOVE_STORY per drop; card-editor.js sends EDIT_STORY on Save, not on keystrokes. Server-only limits also correctly preserve single-user behavior. I found no independent server resource that currently requires collection-count caps in addition to a document-byte cap.

1. Measure bytes, not string length. JSON.stringify(next).length counts UTF-16 code units. My valid Unicode-plan probe measured 472,853 code units but 1,272,853 UTF-8 bytes, passing your proposed check despite exceeding 1 MiB. Use Buffer.byteLength(json, 'utf8') for both room creation and applyOp. Give the HTTP body budget space for the request envelope beyond the document budget.

2. The 64 KiB message limit conflicts with unrestricted fields in imported documents. Using the actual createRoomStore, a valid 72,855-byte document containing a 70 KiB summary produced a 71,794-byte EDIT_STORY after adding one character. Import succeeds; editing disconnects the user. To retain document-only capping, make maxPayload accommodate supported operations from any permitted document, including their envelope—2 MiB is a straightforward option. Otherwise enforce compatible room-only field limits on imports and operations. Add this import-then-edit regression test.

3. Backpressure must cover every send. server/server.js sends nacks directly, outside broadcast/broadcastExcept. An over-limit sender that does not read can therefore accumulate unlimited nack output despite your broadcast checks. Use one guarded send helper for state, nacks and broadcasts; test an over-limit non-reading sender as well as a broadcast recipient.

4. Slow-reader recovery does not exist yet. sync-client.js:wsTransport creates one WebSocket; createRoomStore never subscribes to onClose, and main.js supplies no reconnect behavior. Termination currently leaves a stale board that still appears editable. Include either bounded reconnect with authoritative-state recovery or a visible disconnected state that disables editing and offers reload. Do not claim automatic recovery without implementing and testing it.

5. Last-leave eviction misses rejected joins. server/server.js:handleUpgrade calls getRoom before authentication/token authorization, and getRoom caches immediately. A rejected attempt against an existing uncached room has no socket close to trigger eviction. Cache only admitted rooms, or explicitly clean up unsuccessful admissions. Test wrong-token and wrong-company attempts, not just normal leave/rejoin.

6. Fifty sockets per room does not bound service-wide sockets or active cached documents. Add configurable process-wide connection and pending-upgrade ceilings. Check/reserve admission after asynchronous authentication so concurrent upgrades cannot exceed the limits. Reconnection also resets per-socket buckets; repeated upgrade churn remains outside the proposed rate controls.

7. Define the creation limiter's identity and cleanup precisely. The real auth middleware sets req.user.id, whereas the stub sets req.user.userId (see /var/www/suite/shared/auth-client/middleware.js:48 and server/auth-seam.js). Normalize that identity, test independent real-shaped users, and expire inactive limiter entries so this new Map does not grow indefinitely.

Route-level parsing is safe for the current auth client: I checked its actual launch, logout, whoami and heartbeat handlers; none reads req.body. One smaller cursor adjustment: main.js throttles at 33 ms, approximately 30.3/s, so allow burst headroom and ensure dropping a rate-limited 'gone' message cannot leave a cursor visible indefinitely.

## Round 2/3 — Claude

Conceded on 1, 2, 3, 5, 7, cursor 'gone', and on 4 and 6 with the specifics below. Revised design:

1. Size: MAX_DOC_BYTES = 1 MiB, measured with Buffer.byteLength(JSON.stringify(doc), "utf8"), in both applyOp and POST /rooms. The POST /rooms body limit is 2 MiB, leaving room for the envelope.
2. Frames: maxPayload = MAX_DOC_BYTES + 64 KiB. No op derived from a permitted document can exceed it, so imports can never strand an editor, and I'm still not adding field caps. Regression test: import a doc holding a 70 KiB summary, then send an EDIT_STORY through the real createRoomStore, and expect an ack, not a 1009 close.
3. One guarded send(ws, msg) helper for state, nack, presence and every broadcast. If bufferedAmount > 1 MiB, terminate instead of sending. Tests cover both a non-reading over-limit sender (whose nacks pile up) and a non-reading broadcast recipient.
4. Recovery: a visible disconnected state, not automatic reconnect. createRoomStore subscribes to transport.onClose. main.js then shows a non-dismissable "Connection lost" modal with a Reload button, which blocks further editing of the stale board. Tested at the store level (onClose fires the hook) and headlessly (server-side terminate shows the modal). The docs and PR won't claim automatic recovery.
5. Eviction: handleUpgrade reads with loadRoom directly and caches the room only after the upgrade is admitted. When the last socket leaves, both the room and its socket-set entry are deleted. Tests: a wrong-token join (open-link) and a wrong-company join (company-only) against an existing room leave no cache entry; a normal leave then rejoin reloads correctly. The cache size is exposed to tests only, through the returned handle.
6. Connections: MAX_ROOM_SOCKETS 50, MAX_TOTAL_SOCKETS 500 and MAX_PENDING_UPGRADES 100. The pending counter is incremented on entering handleUpgrade and decremented in a finally. Admission is checked and reserved synchronously AFTER the await of verifySession, immediately before handleUpgrade, so concurrent upgrades can't overshoot. Refusals are 503. Upgrade churn: rate-limiting reconnects needs a client identity. Every peer is 127.0.0.1 behind apache, and per-session limiting doesn't apply to anonymous open-link guests, so I'm leaving churn rate-limiting out and recording it as residual risk. The concurrency ceilings bound simultaneous cost, and each churned upgrade costs one indexed sqlite read. Trusting X-Forwarded-For from apache is a separate decision for David. If you think churn needs a control now, name one that works without trusted client identity.
7. Room creation: each provider gains userOf(req) (real: req.user.id; stub: req.user.userId). The limiter keeps per-user timestamps over a rolling hour and drops a user's entry once its window is empty. Tests: two real-shaped users are limited independently, and the 21st creation in the window gets 429.
Cursors: 40/s with a burst of 60, against the client's ~30/s. A `gone` frame is never rate-limited.
Name: trimmed and capped at 40 chars server-side.

Agree?

## Round 2/3 — ChatGPT: OBJECT

I accept the revised byte budgets, guarded sends, explicit reload recovery, connection ceilings and normalized user identity. Three design gaps remain:

1. Unrestricted 'gone' frames bypass cursor rate limiting. server/server.js currently broadcasts every such frame, so one socket can still flood all 49 peers. Track whether that socket has a relayed visible cursor. Always relay its first disappearance, then ignore repeated 'gone' frames until another position passes the cursor bucket. This preserves reliable removal while bounding fan-out. Test both repeated 'gone' spam and removal after exhausting position tokens.

2. Upgrade rate limiting does not require client identity. Use a process-wide token bucket before loadRoom and verifySession—for example, configurable 50 upgrades/s with burst 100. It bounds expensive work without trusting X-Forwarded-For; it provides capacity protection rather than per-client fairness. The concurrency ceilings alone allow unlimited sequential churn. Also, server/db.js:loadRoom does SELECT *, JSON.parse and migration of the entire document, potentially 1 MiB, rather than merely reading indexed metadata. Test that exhausted admission tokens prevent database/auth calls and refill permits later joins.

3. Admission must preserve one authoritative room object. The proposed direct loadRoom occurs before await verifySession. Installing that snapshot after authentication can overwrite a newer cached document: an existing participant may have committed changes during the await, and server/server.js's message handlers retain their original room references. Use the preliminary load only for authorization; at successful admission reuse the current cached object, or reload from sqlite if none exists. Never install the pre-await snapshot as authoritative. Test a delayed join while an existing participant commits, then verify the joiner's state and subsequent writes from both sockets preserve monotonic versions and persisted changes.

Two implementation requirements should also be explicit. The disconnected flag should suppress dispatch/sendCursor/clearCursor after close; public/js/modal.js's non-dismissable overlay alone does not disable underlying keyboard focus or pointer listeners. And creation-limiter entries need active expiry or a periodic sweep: pruning only when that same user returns leaves inactive users retained indefinitely.

With those changes, the design addresses my objections without field/count caps, automatic reconnect, or trusted proxy identity.

## Round 3/3 — Claude

All three conceded, plus both implementation requirements.

1. Cursor 'gone': each socket tracks hasVisibleCursor. A 'gone' is relayed only if hasVisibleCursor is true (then it's cleared). A position frame relayed past the bucket sets it. Socket close relays a 'gone' if one is visible. (Presence already drops a leaver's cursor client-side, so the close-time 'gone' is belt-and-braces; I'll leave it out unless you see a gap.) Tests: repeated 'gone' spam relays at most one; after exhausting position tokens, a 'gone' still removes the last relayed cursor.
2. Upgrade rate: a process-wide token bucket (50/s, burst 100, configurable) checked first thing in handleUpgrade, before any db or auth call; refusal is 503. Test with an injectable clock: exhausted tokens mean neither verifySession nor the db is touched (a counting spy auth provider plus a counting db read), and later joins succeed after refill.
3. One authoritative room object: for authorization, handleUpgrade uses a new db.loadRoomMeta(id), which SELECTs only id, company_id, share_token and mode (no document parse). After the await and a successful decision, admission calls getRoom(id): it returns the cached object if one exists, otherwise loads from sqlite and caches. No pre-await document is ever installed. This also addresses your loadRoom cost point, since unauthenticated or rejected joins never parse a document. Test: a slow-auth joiner starts while an existing participant commits during the delay. The joiner's state frame must carry the newer version, and subsequent writes from both sockets give strictly increasing versions, with all changes persisted.
Disconnected state: createRoomStore gets a `closed` flag set by onClose. dispatch, sendCursor and clearCursor become no-ops once closed (unit-tested), and main.js shows the non-dismissable Reload modal. So the stale board can't send anything, whatever has focus.
Creation limiter: every call sweeps all entries, dropping timestamps older than an hour and deleting empty users (O(active users), which is tiny), so idle users don't accumulate. Test: an idle user's entry is gone after the window passes on the injected clock.

Agree?

## Round 3/3 — ChatGPT: AGREE

The revised design resolves my objections. Metadata-only authorization avoids premature document loading, and selecting the authoritative room after authentication preserves concurrent commits. The global upgrade bucket works without client identity. Tracking cursor visibility prevents repeated 'gone' frames from bypassing rate limits. Omit close-time 'gone': public/js/main.js:renderPresence already removes departed participants’ cursors through reconcileCursors. Sweeping creation entries on every request prevents inactive users accumulating as traffic continues. Preserve the earlier invariant that failed upgrades never populate the document cache. Implementation should include the agreed regression tests; this approves the design.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Keep limits server-side and leave single-user validation unchanged. Cap documents at 1 MiB of UTF-8 JSON, WebSocket messages at 1 MiB plus 64 KiB, and authenticated room-creation bodies at 2 MiB. Limit ops to 20/s with burst 40, cursor positions to 40/s with burst 60, and relay disappearance once per visible cursor. Guard every outbound send and terminate sockets exceeding 1 MiB buffered output. Cap connections at 50 per room, 500 total and 100 pending upgrades; apply a global upgrade bucket of 50/s with burst 100 before database/auth work. Authorize using room metadata, then reuse or freshly load one authoritative document after successful admission; evict it and its socket set on last leave. Limit creation to 20 rooms per user per rolling hour with normalized identity and swept entries. Trim names to 40 characters. After disconnect, suppress sends and show a blocking Reload modal. Verify boundary rejection, process survival, backpressure, concurrency, expiry and client recovery with the agreed tests.

