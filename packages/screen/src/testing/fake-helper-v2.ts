import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequestV2 } from "@ace/protocol";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Fake requires unix endpoint");
let socket: Socket | undefined;
await rm(endpoint.slice(5), { force: true });
const server = createServer((client) => {
  socket = client;
  client.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(endpoint.slice(5), resolve));
let session = "";
let seq = 0;
let active = false;
let value = "original";
function node() {
  return {
    ref: "save",
    role: "button",
    name: "Save",
    value,
    bounds: { x: 10, y: 20, w: 80, h: 30 },
    states: [],
    actions: ["press", "setValue"],
    children: [],
  };
}
function frame() {
  if (!active || !session) return;
  if (!socket) throw new Error("No frame connection");
  const payload = Buffer.from(`v2-jpeg-${seq}`);
  const header = Buffer.from(
    JSON.stringify({
      version: 2,
      sessionId: session,
      seq: seq++,
      ts: 1000,
      width: 100,
      height: 100,
      scale: 1.5,
      codec: "jpeg",
      bytes: payload.length,
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  socket.write(prefix.subarray(0, 2));
  socket.write(Buffer.concat([prefix.subarray(2), header, payload]));
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = ScreenHelperRequestV2.parse(JSON.parse(line));
  let data: unknown;
  let error: { code: string; message: string } | undefined;
  switch (request.op) {
    case "hello":
      data = {
        version: process.env.BAD_VERSION === "1" ? 3 : 2,
        platform: "windows",
        capture: { windows: true, displays: false, changeDriven: true },
        input: { pointer: true, keyboard: true, scroll: true, text: true },
        uiTree: process.env.NO_UI !== "1",
        semanticActions: ["press", "setValue"],
        codecs: ["jpeg"],
        permissions: { screen: "n/a", input: "granted" },
      };
      break;
    case "permissions":
      data = { screen: "n/a", input: "granted" };
      break;
    case "targets":
      data = {
        windows: [{ windowId: 1, bundleId: "dev.ace.test", title: `${process.pid}:${active}` }],
        displays: [],
      };
      break;
    case "start":
      session = request.sessionId;
      seq = 0;
      active = true;
      setImmediate(frame);
      break;
    case "stop":
      active = false;
      session = "";
      break;
    case "watch":
      active = request.active;
      if (active) setImmediate(frame);
      break;
    case "ui.tree":
      data = { root: node(), truncated: false };
      break;
    case "ui.find":
      data = { nodes: request.query.name === "missing" ? [] : [node()], truncated: false };
      break;
    case "ui.act":
      if (request.ref === "busy") error = { code: "busy", message: "UAC active" };
      else if (request.ref !== "save") error = { code: "target_gone", message: "Element expired" };
      else {
        if (request.action === "setValue" && typeof request.value === "string")
          value = request.value;
        data = { fallback: false };
      }
      break;
    case "key.press":
      value = `${request.modifiers.join("+")}:${request.key}`;
      break;
    case "action":
      if (request.action.kind === "type") {
        if (request.action.text === "crash") process.exit(7);
        value = request.action.text;
      }
      break;
  }
  console.log(JSON.stringify({ version: 2, id: request.id, ok: error === undefined, data, error }));
});
lines.on("close", () => {
  socket?.destroy();
  server.close();
});
