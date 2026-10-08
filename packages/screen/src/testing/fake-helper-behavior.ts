import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest, ScreenError } from "@ace/protocol";
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Fixture endpoint required");
const socket = connect(endpoint.slice(5));
socket.on("error", () => process.exit(1));
const values = new Map<string, string>();
const targets = new Map<string, number>();
let permissionQueries = 0;
let windowQueries = 0;
let lastOp = "";
let permissions = { screenRecording: true, accessibility: true };
const candidates = (bundleId: string) => [
  {
    bundleId,
    windowId: 1,
    title: "First",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    focused: false,
    usable: true,
  },
  {
    bundleId,
    windowId: 2,
    title: "Focused",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    focused: true,
    main: true,
    usable: true,
  },
];
const snapshot = (id: string) => ({
  nodes: [
    {
      ref: "field",
      role: "AXTextField",
      name: "Value",
      value: values.get(id) ?? "",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      states: [],
      actions: ["setValue"],
      children: [],
    },
  ],
  truncated: false,
});
function log(op: string) {
  if (process.env.HELPER_LOG) appendFileSync(process.env.HELPER_LOG, JSON.stringify({ op }) + "\n");
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void dispatch(ScreenHelperRequest.parse(JSON.parse(line))).catch(() => process.exit(1));
});
async function dispatch(request: ScreenHelperRequest) {
  log(request.op);
  if (process.env.REQUEST_DELAY_MS)
    await new Promise<void>((resolve) => setTimeout(resolve, Number(process.env.REQUEST_DELAY_MS)));
  if (
    request.op === "input" &&
    (request.input.kind === "text.type" || request.input.kind === "text.paste") &&
    request.input.text === "held"
  ) {
    await new Promise<void>((resolve, reject) => {
      const control = connect(Number(process.env.ACTION_GATE_PORT), "127.0.0.1");
      control.on("error", reject);
      control.once("connect", () => control.write("action started\n"));
      control.once("end", resolve);
      control.resume();
    });
  }
  let data: unknown;
  const id = request.sessionId ?? "";
  const reply = (error?: unknown) =>
    console.log(
      JSON.stringify({ version: request.version, id: request.id, ok: !error, data, error }),
    );
  switch (request.op) {
    case "hello":
      data = {
        version: 2,
        platform: "macos",
        background: true,
        windowSelection: process.env.LEGACY_HELPER !== "1",
        permissionEvents: process.env.LEGACY_HELPER !== "1",
        maxSessions: 8,
        capture: { windows: true, displays: false, changeDriven: true },
        input: { pointer: true, keyboard: true, scroll: true, text: true },
        uiTree: true,
        semanticActions: ["setValue"],
        codecs: ["jpeg"],
        permissions: { screen: "granted", input: "granted" },
      };
      break;
    case "permissions":
      permissionQueries++;
      data = permissions;
      if (process.env.REVOKE_DURING_QUERY === "1") {
        permissions = { screenRecording: true, accessibility: false };
        console.log(JSON.stringify({ version: 2, event: "permissions.changed", permissions }));
      }
      break;
    case "open.app":
      data = { bundleId: request.bundleId, pid: 123, mode: "background" };
      break;
    case "targets":
      data = { windows: candidates("dev.ace.test"), displays: [] };
      break;
    case "windows.list":
      windowQueries++;
      data = {
        windows:
          windowQueries <= Number(process.env.NOT_READY_QUERIES ?? 0)
            ? []
            : candidates(request.bundleId),
        ...(process.env.AMBIGUOUS !== "1" &&
        windowQueries > Number(process.env.NOT_READY_QUERIES ?? 0)
          ? { selectedWindowId: 2 }
          : {}),
      };
      break;
    case "window.select":
      if (![1, 2].includes(request.windowId))
        return reply({
          code: "target_gone",
          message: "Fixture window disappeared",
          phase: "rejected-before-dispatch",
        });
      targets.set(id, request.windowId);
      break;
    case "start":
      targets.set(id, request.target.kind === "window" ? request.target.windowId : 0);
      break;
    case "stop":
      targets.delete(id);
      break;
    case "ui.tree":
      log("traversal");
      data = { ...snapshot(id), metrics: { permissionQueries }, target: targets.get(id), lastOp };
      break;
    case "input":
      if (request.input.kind === "text.type" && request.input.text === "revoke") {
        permissions = { screenRecording: true, accessibility: false };
        console.log(JSON.stringify({ version: 2, event: "permissions.changed", permissions }));
        return reply({
          code: "permission_denied",
          message: "Accessibility denied",
          phase: "rejected-before-dispatch",
        });
      }
      if (request.input.kind === "key.press" && process.env.AUTHORED_ERROR)
        return reply(
          ScreenError.parse({
            code: process.env.AUTHORED_ERROR,
            message: "Fixture authored failure",
            ...(process.env.AUTHORED_ERROR === "window_ambiguous"
              ? {
                  candidates: [
                    {
                      windowId: 2,
                      title: "Native candidate",
                      bounds: { x: 0, y: 0, w: 100, h: 100 },
                    },
                  ],
                }
              : {}),
            phase: process.env.DISPATCH_PHASE ?? "rejected-before-dispatch",
          }),
        );
      if (!permissions.accessibility)
        return reply({
          code: process.env.LEGACY_HELPER === "1" ? "internal" : "permission_denied",
          message: "Accessibility denied",
          phase: "rejected-before-dispatch",
        });
      values.set(
        id,
        request.input.kind === "text.type" || request.input.kind === "text.paste"
          ? request.input.text
          : request.input.kind,
      );
      log("traversal");
      data = { mode: request.mode, snapshot: snapshot(id) };
      if (request.input.kind === "text.type" && request.input.text === "revoke-silent")
        permissions = { screenRecording: true, accessibility: false };
      break;
    case "ui.act":
      values.set(id, String(request.value));
      log("traversal");
      data = { fallback: false, snapshot: snapshot(id) };
      break;
    case "open.url":
      values.set(id, request.url);
      log("traversal");
      data = { snapshot: snapshot(id) };
      lastOp = request.op;
      break;
    case "menu.press":
      values.set(id, request.path.join(" > "));
      log("traversal");
      data = { snapshot: snapshot(id) };
      lastOp = request.op;
      break;
  }
  reply();
}
lines.on("close", () => socket.end());
