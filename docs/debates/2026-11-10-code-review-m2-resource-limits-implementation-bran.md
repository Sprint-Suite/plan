# Debate: Code review: M2 resource limits implementation, branch fix/m2-resource-limits

- Id: 2026-11-10-code-review-m2-resource-limits-implementation-bran
- Opened: 2026-11-10T12:26:33.764Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

This implements the design agreed in docs/debates/2026-11-10-design-m2-resource-limits-for-the-sprintplan-rooms.md. The range is main..HEAD on fix/m2-resource-limits. Do not read data/ or node_modules/.

Files: server/limits.js (new), server/room-hub.js (new: cache, sockets, reservations, guarded send, eviction), server/server.js (rewritten around the hub: mountCreateRoom, attachUpgrades, admit, participantMeta, relayCursor, handleMessage), server/db.js (loadRoomMeta), server/auth.js (userOf), server/rooms.js (UTF-8 doc cap in applyOp), public/js/sync-client.js (closed flag + onDisconnect), public/js/room-gate.js (showConnectionLost), public/js/main.js (wiring). Tests: tests/limits.test.js and tests/rooms-limits.test.js (16 server-level tests), plus one new sync-client test.

One deviation from the agreed design, which I'm flagging for you to challenge: maxBufferedBytes is 2 x maxFrameBytes (about 2.1 MiB), not 1 MiB. The backpressure test exposed that a backlog limit below the largest frame cuts off healthy readers. After one large frame (e.g. a full ~1 MiB state frame), the next send (the presence frame right after it) finds bufferedAmount above the limit and terminates a joiner who is reading normally. The test now asserts that the reading sender survives while the paused recipient is cut. The test paces the sender (5 ops, then 5 ms), because an unpaced 60 MB burst legitimately backs up even a reading client. In production the per-socket op bucket and realistic op sizes (under 1 KB) bound that.

Verification: npm test 327/327, typecheck clean. Each limit test was watched failing before implementation, except two that already held as regression guards (the 70 KiB import-then-edit, and the slow-auth joiner, which passed before only because the old code cached pre-auth). With the backlog check disabled, both backpressure tests fail. Headless Chromium: killing the rooms server shows the blocking "Connection lost" modal with Reload, and no page errors.

Check: reservation accounting (reserve/attach/release/detach, including handshake aborts, attach throwing on a corrupt room, and the socket 'close' listener versus attached), eviction correctness, the order of checks in the upgrade path, whether any send still bypasses hub.send, the creation limiter (counts only successful creations, after validation and the size check), and anything that could leak or throw.

## Round 1/3 — ChatGPT: OBJECT

I inspected main..HEAD at 08436ab. Two reproduced issues remain:

1. Backpressure bypass through automatic Pong replies. server/server.js:121 leaves ws automatic Pong handling enabled, bypassing server/room-hub.js:38's guarded send. Using an in-memory Duplex socket attached to the real hub, 40,000 valid masked Pings left the connection OPEN with 5,080,000 bytes buffered against the 2,228,224-byte ceiling. No application messages are needed, so neither op nor cursor buckets intervene. Disable automatic Pong replies and handle Pings through a shared backlog guard, preserving the Ping payload in each Pong. Add a blocked-reader Ping regression test.

2. Failed creation consumes quota. server/server.js:83 records the creation before createRoom at line 86 succeeds. With roomsPerUserPerHour=1 and a SQLite trigger rejecting the insert, my first request failed; after removing the trigger, the next request returned 429 with zero rooms persisted. Separate checking from recording, recording only after successful insertion, or roll back the quota on failure. Add a database-failure regression test.

I accept increasing maxBufferedBytes to twice maxFrameBytes: allowing headroom beyond a supported state frame is reasonable. It does not resolve the Pong bypass.

Independent verification: 12 limiter/sync-client unit tests passed; frontend typecheck passed. Server integration tests were blocked by sandbox listen EPERM, so I cannot confirm the reported 327-test result. No files changed, no commit or push made, and no project server remains running.

## Round 2/3 — Claude

Both conceded and fixed in the latest commit on fix/m2-resource-limits, each test watched failing first.

1. Pongs: the WebSocketServer is created with autoPong:false, and each connection handles ws.on("ping", data => hub.pong(ws, data)). hub.pong runs the same writable() guard as every send (cut off when bufferedAmount > maxBufferedBytes, skip when not OPEN), then ws.pong(data), echoing the payload. Regression: a client that pauses its socket and sends 40,000 pings with 125-byte payloads is cut off (socketCount reaches 0). Before the fix it stayed connected (red).
2. Quota: the window limiter now exposes check() and record(), with allow() = check then record. POST /rooms calls check() before creating and record() only after createRoom returns. Regression, using your SQLite-trigger method: with roomsPerUserPerHour=1 and a trigger aborting the insert, the first request is a 500; after the trigger is dropped, the next is a 200, not a 429 (red before the fix). A unit test also confirms check() alone uses no quota.

Full suite: 330/330 on four consecutive runs. One earlier full run had timing failures in the crash-survival and slow-auth tests; those pass in isolation and in every rerun. I'm reporting it rather than hiding it. CI on the PR is the next independent check. Do you agree M2 is complete?

## Round 2/3 — ChatGPT: AGREE

I reviewed commit acac2b3 and independently reproduced both fixes. With the actual hub and connection handler on an in-memory socket, normal Pings received payload-identical Pongs; a blocked-reader Ping flood terminated the socket and evicted its room cache. A SQLite-triggered insert failure preserved creation quota; the next creation succeeded, and the following attempt was limited. The check/create/record sequence is synchronous, so splitting quota checking from recording introduces no request-interleaving race.

All 13 limiter/sync-client unit tests passed, alongside syntax checks, frontend typecheck and the follow-up diff whitespace check. Full network integration remains unverified here because the sandbox prohibits listening sockets. The reported timing failures remain a test-stability concern for CI, but I found no remaining implementation blocker.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Accept M2 at acac2b3: retain the agreed server-side document, frame, rate, connection and cache limits, with backlog headroom of twice maxFrameBytes. Disable automatic Pongs and guard explicit Pong replies through the same writable check as application output. Record creation quota only after successful persistence. Preserve authoritative room admission and the disconnected-client Reload flow. M2 is implementation-complete; CI remains the independent merge check.

