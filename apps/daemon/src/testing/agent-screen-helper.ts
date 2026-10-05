import { createServer, type Socket } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createInterface } from "node:readline";
import { ScreenHelperRequestV2 } from "@ace/protocol";
import { framePacket } from "@ace/screen";

const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Expected isolated frame endpoint");
let socket: Socket | undefined;
await rm(endpoint.slice(5), { force: true });
const server = createServer((client) => {
  socket = client;
  client.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(endpoint.slice(5), resolve));
let session = "",
  value = "",
  submitted = false,
  active = false,
  sequence = 0;
function paint() {
  if (!active || !session) return;
  const payload = Buffer.from(`pixels:${submitted ? "Saved " : "Name "}${value}`);
  if (!socket) throw new Error("Frame connection missing");
  socket.write(
    framePacket(
      {
        version: 2,
        sessionId: session,
        seq: sequence++,
        captureGeneration: generation,
        ts: 1,
        width: 100,
        height: 200,
        scale: 2,
        codec: "jpeg",
        bytes: payload.length,
      },
      payload,
    ),
  );
}
let generation = 1;
const node = (
  ref: string,
  name: string,
  role: string,
  actions: ("press" | "setValue" | "focus")[],
) => ({
  ref,
  name,
  role,
  value,
  bounds: { x: 1, y: 2, w: 30, h: 20 },
  actions,
  states: [],
  children: [],
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = ScreenHelperRequestV2.parse(JSON.parse(line));
  let data: unknown;
  let error: { code: string; message: string } | undefined;
  switch (request.op) {
    case "hello":
      data = {
        version: 2,
        platform: "windows",
        capture: { windows: true, displays: false, changeDriven: true },
        input: { pointer: true, keyboard: true, scroll: true, text: true },
        uiTree: true,
        semanticActions: ["press", "setValue", "focus"],
        codecs: ["jpeg"],
        permissions: { screen: "n/a", input: "granted" },
      };
      break;
    case "permissions":
      data = { screen: "n/a", input: "granted" };
      break;
    case "targets":
      data = {
        windows: [{ windowId: 1, bundleId: "dev.ace.journey", title: "Form" }],
        displays: [],
      };
      break;
    case "start":
      session = request.sessionId;
      generation = request.captureGeneration ?? 1;
      active = true;
      paint();
      break;
    case "watch":
      active = request.active;
      generation = request.captureGeneration ?? generation;
      paint();
      break;
    case "ui.tree":
      data = {
        root: submitted
          ? node("result", "Saved", "text", [])
          : {
              ...node("form", "Form", "group", []),
              children: [
                node("name", "Name", "textbox", ["focus", "setValue"]),
                node("submit", "Submit", "button", ["press"]),
              ],
            },
        truncated: false,
      };
      break;
    case "ui.find":
      data = {
        nodes:
          request.query.name === "Name" && !submitted
            ? [node("name", "Name", "textbox", ["focus", "setValue"])]
            : [],
        truncated: false,
      };
      break;
    case "ui.act":
      if (submitted || !["name", "submit"].includes(request.ref))
        error = { code: "target_gone", message: "Element expired; refresh the UI tree" };
      else {
        if (request.action === "setValue") value = String(request.value);
        if (request.ref === "submit" && request.action === "press") submitted = true;
        data = { fallback: false };
        paint();
      }
      break;
    case "text.type":
      if (request.text === "gate" && process.env["ACE_SCREEN_GATE"]) {
        const path = process.env["ACE_SCREEN_GATE"];
        const release = new Promise<void>((resolve) => {
          const watcher = watch(path, () => {
            watcher.close();
            resolve();
          });
        });
        await writeFile(`${path}.entered`, "entered");
        await release;
      }
      value += request.text;
      paint();
      break;
    case "key.press":
      if (request.key === "Enter") submitted = true;
      paint();
      break;
    case "stop":
      active = false;
      break;
  }
  console.log(JSON.stringify({ version: 2, id: request.id, ok: !error, data, error }));
}
socket?.destroy();
server.close();
