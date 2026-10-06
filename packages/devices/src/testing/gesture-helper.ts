import { appendFile } from "node:fs/promises";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Missing frame endpoint");
const socket = connect(endpoint.slice(5));
socket.on("error", () => process.exit(2));
const journal = process.env["GESTURE_JOURNAL"];
if (!journal) throw new Error("Missing gesture journal");
let held: object | undefined;
let captured = "none";
let permissions = 0;
let heldPermission: { id: string; version: number } | undefined;
let observedPermission = false;
let heldTargets: { id: string; version: number } | undefined;
function targetsReply(request: { id: string; version: number }) {
  console.log(
    JSON.stringify({
      version: request.version,
      id: request.id,
      ok: true,
      data: {
        windows: [
          {
            windowId: 1,
            bundleId: "com.apple.iphonesimulator",
            title: `Simulator;heldPermission:${Boolean(heldPermission)}`,
          },
        ],
        displays: [],
      },
    }),
  );
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  let data: unknown;
  switch (request.op) {
    case "hello":
      data = {
        version: 2,
        platform: "macos",
        capture: { windows: true, displays: false, changeDriven: true },
        input: { pointer: true, keyboard: true, scroll: true, text: true },
        uiTree: false,
        semanticActions: [],
        codecs: ["jpeg"],
        background: process.env["REJECT_BACKGROUND_FOCUS"] === "1",
        permissions: { screen: "granted", input: "granted" },
      };
      break;
    case "permissions":
      permissions++;
      if (permissions > 1 && process.env["HOLD_PERMISSION"] === "1") {
        heldPermission = request;
        if (heldTargets) {
          observedPermission = true;
          targetsReply(heldTargets);
          heldTargets = undefined;
        }
        continue;
      }
      data = { screenRecording: true, accessibility: true };
      break;
    case "start":
      captured =
        request.target.kind === "display"
          ? "display"
          : `${request.target.bundleId}:${request.target.kind === "window" ? request.target.windowId : "app"}`;
      break;
    case "input":
      if (process.env["REJECT_BACKGROUND_FOCUS"] === "1" && !request.humanDeviceInput) {
        console.log(
          JSON.stringify({
            version: request.version,
            id: request.id,
            ok: false,
            error: {
              code: "foreground_required",
              message: "Focus changed during human input; the human's desktop was retained",
            },
          }),
        );
        continue;
      }
      await appendFile(journal, JSON.stringify({ target: captured, input: request.input }) + "\n");
      if (process.env["HOLD_DRAG"] === "1") {
        held = request;
        continue;
      }
      break;
    case "targets":
      if (process.env["HOLD_PERMISSION"] === "1" && permissions <= 1) {
        // This public request is a barrier: it replies only after the input's permission read arrives.
        heldTargets = request;
        continue;
      }
      if (heldPermission && observedPermission) {
        console.log(
          JSON.stringify({
            ...heldPermission,
            ok: true,
            data: { screenRecording: true, accessibility: true },
          }),
        );
        heldPermission = undefined;
      } else if (heldPermission) observedPermission = true;
      if (held) {
        console.log(
          JSON.stringify({ version: 2, id: "id" in held ? held.id : "invalid", ok: true }),
        );
        held = undefined;
      }
      data = {
        windows: [
          {
            windowId: 1,
            bundleId: "com.apple.iphonesimulator",
            title: `Simulator;heldPermission:${Boolean(heldPermission)}`,
          },
        ],
        displays: [],
      };
      break;
    case "stop":
      break;
  }
  console.log(JSON.stringify({ version: request.version, id: request.id, ok: true, data }));
}
socket.destroy();
