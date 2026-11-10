# Debate: Code review: room keepalive, suite heartbeat, monotonic rate clock (branch fix/room-keepalive-and-suite-heartbeat)

- Id: 2026-11-10-code-review-room-keepalive-suite-heartbeat-monoton
- Opened: 2026-11-10T13:41:17.435Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

Context: David left a live room idle for 30 minutes and got the "Connection lost" modal (added in M2). Reload worked, so his login was valid: the ws tunnel had closed for lack of traffic. He wants teams to be able to talk for long stretches before touching the board. Separately, plan never refreshes the suite's central session (hub sessionIdleMs = 30 min; plan doesn't include the suite heartbeat script, unlike retrospective), so a long discussion would also end the suite login, and Collaborate would then bounce to the suite login. Range: main..HEAD on fix/room-keepalive-and-suite-heartbeat, one commit. Do not read data/ or node_modules/.

Changes:
1. Keepalive: LIMITS.pingIntervalMs = 30000. startSpikeServer runs setInterval(hub.sweepLiveness), unref'd and cleared in close(). sweepLiveness terminates any socket whose `alive` is false, otherwise sets alive=false and pings it if writable() (the same backlog guard). ws.on("pong") marks it alive. Browsers answer pings automatically.
2. Suite heartbeat: auth-gate.js startSuiteHeartbeat({hasSuiteSession, doc}) appends <script src="/auth-client/heartbeat.js" defer> only when the gate found a real suite session. main.js calls it right after the gate. Guests never load it, because the script reloads the page on a 401 and a guest's /api/heartbeat is always 401. /auth-client/ and /api/heartbeat are already proxied by apache; CSP script-src 'self' allows it.
3. A bug found while chasing a flaky test: token buckets refilled by (now - last) with Date.now. A wall-clock step backwards (seen on WSL) made that negative and drained the bucket, so a sender at opRate 10000/burst 10000 got "too many changes" nacks. Fixed: elapsed is clamped to >= 0, and buckets plus the server default clock use performance.now(). Test: a clock stepping back 5 s leaves the full burst.
4. Test hygiene: rooms-limits tests now close every server, socket and db in afterEach, pass or fail. Previously a failed test left sockets open and hung the whole node --test run (until a 500 s timeout). The backpressure test is flow-controlled: the reading sender waits for its own acks every 5 ops, rather than relying on timing.

Verification: new tests watched red first. An answering idle client gets >= 3 pings in 400 ms at a 50 ms interval and stays connected; an autoPong:false client is cut. The heartbeat script is appended for a suite user and not for a guest. The bucket survives a backwards clock. The limits file passed 6/6 after the fix (it had failed 2/5). npm test 335/335 twice, ~3.7 s each; typecheck clean.

Check: the liveness sweep's correctness (a freshly attached socket before its first sweep, interaction with backpressure terminate, timer leaks), whether a 30 s interval is right against a typical 60-300 s proxy idle timeout, heartbeat-loading edge cases (a room link with a suite session; a 401 reload loop if the plan session expires), and whether monotonic time breaks anything that expects wall time (the hourly creation window).

## Round 1/3 — ChatGPT: AGREE

I reviewed main..57f136b and the shared heartbeat implementation. In server/room-hub.js, checking alive === false gives newly attached sockets their first ping; subsequent pongs renew liveness, missed pongs trigger termination, and writable() preserves the backlog guard. server/server.js unreferences the timer and clears it on close(). A 30-second interval provides margin below the stated 60–300-second proxy idle timeouts.

public/js/main.js starts the heartbeat for authenticated users on both entry paths, including room links. Guests skip it. The shared handlers/heartbeat.js deletes locally stored sessions when the central session expires; after reload, whoami returns anonymous, preventing a repeating heartbeat/reload cycle. Missing local sessions likewise classify as anonymous. The repository’s Apache proxy snippet includes both required routes.

The monotonic clock is appropriate: the hourly creation limiter stores process-local timestamps and compares elapsed durations, without needing calendar time. Database timestamps and authentication expiry remain unchanged.

I independently passed auth-gate tests (17), limiter tests (5), typecheck, touched-file syntax checks and diff checks. Additional deterministic checks passed for first sweep, pong renewal, missed-pong termination, backpressure, eviction and the hourly boundary. Full-suite verification was restricted by the sandbox; the keepalive tests specifically fail with localhost listen EPERM.

Nonblocking improvement: give tests/rooms-keepalive.test.js failure-safe cleanup too; its current success-only cleanup can leave sockets open after an assertion failure.

## Outcome: AGREED

**Agreed solution, in ChatGPT's words:**

Keep the 30-second server WebSocket ping/pong sweep, load the existing suite heartbeat only for authenticated Plan sessions, and use monotonic elapsed time with nonnegative token refill. Retain the flow-controlled backpressure test and failure-safe resource cleanup.

