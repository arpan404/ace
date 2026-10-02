import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequestV2, ScreenCapabilities } from "@ace/protocol";
import { framePacket } from "../frames.ts";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Expected unix endpoint");
const socket = connect(endpoint.slice(5));
socket.on("error", () => process.exit(1));
let sessionId = "test";
let seq = 0;
const capabilities = ScreenCapabilities.parse({
  version: 2,
  platform: process.env.FAKE_PLATFORM ?? "linux-x11",
  capture: { windows: true, displays: false, changeDriven: true },
  input: { pointer: true, keyboard: true, scroll: true, text: true },
  uiTree: process.env.NO_UI !== "1",
  semanticActions: ["press", "focus", "setValue"],
  codecs: ["jpeg"],
  permissions: { screen: "granted", input: "granted" },
  pid: process.pid,
});
let value = "";
let permissionReads = 0;
const node = () => ({
  ref: "stable-entry",
  role: "entry",
  name: "Message",
  value,
  bounds: { x: 2, y: 2, w: 20, h: 10 },
  states: ["focused"],
  actions: ["setValue", "focus"],
  children: [],
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const r = ScreenHelperRequestV2.parse(JSON.parse(line));
  let data: unknown;
  let error: unknown;
  switch (r.op) {
    case "hello":
      data = capabilities;
      break;
    case "permissions":
      data = {
        screenRecording: process.env.REVOKE_SCREEN !== "1" || ++permissionReads === 1,
        accessibility: true,
      };
      break;
    case "targets":
      data = { displays: [], windows: [{ windowId: 1, bundleId: "dev.ace.test", title: "Test" }] };
      break;
    case "start":
      sessionId = r.sessionId;
      seq = 0;
      data = { capabilities };
      break;
    case "stop":
      if (process.env.FAIL_STOP === "1") error = { code: "internal", message: "Stop failed" };
      break;
    case "ui.tree":
      data = { tree: node(), truncated: r.maxDepth === 0 };
      break;
    case "ui.find":
      data = { nodes: r.query.name === "absent" ? [] : [node()], truncated: false };
      break;
    case "ui.act":
      if (r.ref !== "stable-entry") error = { code: "target_gone", message: "Unknown ref" };
      else {
        if (r.action === "setValue") value = r.value ?? "";
        data = { fallback: false, method: "atspi" };
      }
      break;
    case "action":
    case "key.press": {
      const payload = Buffer.from("fake-jpeg");
      socket.write(
        framePacket(
          {
            version: 2,
            sessionId,
            sequence: seq,
            seq: seq++,
            timestamp: 1000,
            ts: 1000,
            width: 100,
            height: 80,
            scale: 1,
            codec: "jpeg",
            bytes: payload.length,
          },
          payload,
        ),
      );
      break;
    }
  }
  console.log(JSON.stringify({ version: 2, id: r.id, ok: !error, data, error }));
});
input.on("close", () => socket.end());
