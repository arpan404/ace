import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
import { framePacket } from "../frames.ts";
const path = process.argv.at(-1);
if (!path) throw new Error("Missing socket path");
const socket = connect(path);
socket.on("error", () => process.exit(1));
let sessionId = "test";
let sequence = 0;
let permissionQueries = 0;
function frame() {
  const payload = Buffer.from(`jpeg-${sequence}`);
  const packet = framePacket(
    {
      version: 1,
      sessionId,
      sequence: sequence++,
      timestamp: 1000,
      width: 100,
      height: 100,
      codec: "jpeg",
      bytes: payload.length,
    },
    payload,
  );
  // Split every header and payload across multiple writes.
  socket.write(packet.subarray(0, 2));
  socket.write(packet.subarray(2, 9));
  socket.write(packet.subarray(9));
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  let data: unknown;
  if (request.op === "permissions") {
    permissionQueries++;
    data = {
      screenRecording: process.env.SCREEN_DENIED !== "1",
      accessibility: process.env.ACCESS_DENIED !== "1",
    };
    if (process.env.REVOKE_ACCESS === "1" && permissionQueries > 1)
      data = { screenRecording: true, accessibility: false };
  }
  if (request.op === "targets")
    data = {
      displays: [{ displayId: 1, width: 100, height: 100 }],
      windows: [{ windowId: 1, bundleId: "dev.ace.test", title: "Test" }],
    };
  if (request.op === "start") {
    sessionId = request.sessionId ?? "test";
    if (process.env.INITIAL_FRAME === "1") frame();
  }
  if (request.op === "action") {
    if (request.action?.kind === "type" && request.action.text === "crash") {
      process.exit(7);
    }
    frame();
    data = { action: request.action };
  }
  console.log(JSON.stringify({ version: 1, id: request.id, ok: true, data }));
});
lines.on("close", () => {
  socket.end();
});
