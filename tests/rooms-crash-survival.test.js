// @ts-check
/**
 * The rooms service must survive hostile input from any admitted socket. Runs
 * the real server in a child process and asserts it is still serving afterwards.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

/** @type {import("node:child_process").ChildProcess} */
let child;
let port = 0;
let exited = false;

before(async () => {
  child = spawn(process.execPath, ["tests/fixtures/rooms-child.js"], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", () => { exited = true; });
  port = await new Promise((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      const m = /PORT=(\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
  });
});
after(() => { child.kill(); });

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function assertAlive() {
  await wait(150);
  assert.equal(exited, false, "rooms service process exited");
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
}

/** Open a socket to the seeded room and resolve once the state frame arrives. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=r&token=t&name=x`);
    ws.once("message", () => resolve(ws));
    ws.once("error", reject);
  });
}

const HOSTILE_FRAMES = [
  "null",
  "42",
  '"str"',
  "[]",
  '{"type":"op"}',
  '{"type":"op","op":null}',
  '{"type":"op","op":{"type":{"toString":null}}}',
  '{"type":"op","op":{"type":"EDIT_STORY","payload":null}}',
  '{"type":"op","op":{"type":"ADD_STORY","payload":{"epicId":{"toString":null}}}}',
  '{"type":"cursor","x":null}',
];

for (const frame of HOSTILE_FRAMES) {
  test(`service survives ws frame ${frame}`, async () => {
    const ws = /** @type {WebSocket} */ (await connect());
    ws.send(frame);
    await assertAlive();
    ws.close();
  });
}

test("a hostile frame from one client does not stop a valid op reaching others", async () => {
  const a = /** @type {WebSocket} */ (await connect());
  const b = /** @type {WebSocket} */ (await connect());
  const got = new Promise((resolve) => b.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "op") resolve(m);
  }));
  a.send("null");
  a.send(JSON.stringify({ type: "op", opId: "1", op: { type: "SET_PLAN_TITLE", payload: { title: "ok" } } }));
  const m = /** @type {any} */ (await got);
  assert.equal(m.op.type, "SET_PLAN_TITLE");
  a.close(); b.close();
});

test("service survives an upgrade to a room whose stored document is corrupt", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=corrupt&token=t&name=x`);
  await new Promise((resolve) => { ws.once("error", resolve); ws.once("close", resolve); });
  await assertAlive();
});
