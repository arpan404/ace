import { appendFile } from "node:fs/promises";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Missing helper frame endpoint");
const socket = connect(endpoint.slice(5));
socket.on("error", () => process.exit(2));
const journal = process.env["ACE_FEATURE_SCREEN_JOURNAL"];
if (!journal) throw new Error("Missing screen journal");
for await (const line of createInterface({ input: process.stdin })) {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  let data: unknown;
  if (request.op === "hello")
    data = {
      version: 2,
      platform: "macos",
      background: true,
      maxSessions: 8,
      capture: { windows: true, displays: false, changeDriven: true },
      input: { pointer: true, keyboard: true, scroll: true, text: true },
      uiTree: true,
      semanticActions: ["press"],
      codecs: ["jpeg"],
      permissions: { screen: "granted", input: "granted" },
    };
  if (request.op === "permissions") data = { screenRecording: true, accessibility: true };
  if (request.op === "ui.tree")
    data = {
      nodes: [
        {
          ref: "save",
          role: "button",
          name: "Save",
          bounds: { x: 1, y: 2, w: 20, h: 10 },
          states: [],
          actions: ["press"],
          children: [],
        },
      ],
      truncated: false,
    };
  if (request.op === "ui.act") {
    await appendFile(journal, JSON.stringify({ ref: request.ref, action: request.action }) + "\n");
    data = { fallback: false };
  }
  if (request.op === "input") await appendFile(journal, JSON.stringify(request.input) + "\n");
  console.log(JSON.stringify({ version: request.version, id: request.id, ok: true, data }));
}
socket.destroy();
