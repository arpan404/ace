import { z } from "zod";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequestV2, ScreenUINode } from "@ace/protocol";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Fake requires unix endpoint");
const padding = z.coerce
  .number()
  .int()
  .min(0)
  .max(1048576)
  .parse(process.env.PAYLOAD_PADDING ?? 0);
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
let generation = 1;
let starts = 0;
let held: Buffer | undefined;
let retired: Buffer | undefined;
let heldOnce = false;
function node(): typeof ScreenUINode._output {
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
function packet(text?: string): Buffer {
  const sequence = seq++;
  const content =
    text ??
    (process.env.RETIRED_ON_RESUME === "1"
      ? "fresh"
      : process.env.PAYLOAD_VALUE === "1"
        ? `pixels:${value}`
        : `v2-jpeg-${sequence}`);
  const payload = Buffer.from(content + "x".repeat(padding));
  const header = Buffer.from(
    JSON.stringify({
      version: 2,
      sessionId: session,
      seq: sequence,
      captureGeneration: generation,
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
  return Buffer.concat([prefix, header, payload]);
}
function frame() {
  if (!active || !session || process.env.NO_FRAMES === "1") return;
  if (!socket) throw new Error("No frame connection");
  const bytes = packet();
  if (process.env.BACKPRESSURE_RESTART === "1" && starts === 1 && !heldOnce) {
    heldOnce = true;
    socket.write(bytes.subarray(0, 1));
    held = bytes.subarray(1);
    return;
  }
  socket.write(bytes.subarray(0, 2));
  socket.write(bytes.subarray(2));
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
      if (held) {
        socket?.write(held);
        held = undefined;
      }
      starts++;
      session = request.sessionId;
      generation = request.captureGeneration ?? 1;
      seq = 0;
      active = true;
      frame();
      break;
    case "stop":
      if (process.env.STOP_ERROR === "1") {
        error = { code: "busy", message: "native stop rejected" };
        break;
      }
      active = false;
      session = "";
      break;
    case "watch":
      if (!request.active && active && process.env.RETIRED_ON_RESUME === "1")
        retired = packet("retired");
      active = request.active;
      if (active) {
        generation = request.captureGeneration ?? generation;
        if (retired) {
          socket?.write(retired);
          retired = undefined;
        }
        frame();
      }
      break;
    case "ui.tree":
      {
        let root = node();
        if (process.env.UI_MODE === "nodes") root.children = [node(), node()];
        if (process.env.UI_MODE === "depth") root.children = [node()];
        data = {
          root: process.env.UI_MODE === "states" ? { ...root, states: ["invented"] } : root,
          truncated: false,
        };
      }
      break;
    case "ui.find":
      data = {
        nodes:
          request.query.name === "missing"
            ? []
            : process.env.UI_MODE === "findCount"
              ? [node(), node()]
              : [
                  process.env.UI_MODE === "findChildren"
                    ? { ...node(), children: [node()] }
                    : node(),
                ],
        truncated: false,
      };
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
