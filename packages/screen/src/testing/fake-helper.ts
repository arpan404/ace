import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
import { framePacket } from "../frames.ts";
if (process.env.LEGACY_ONLY === "1" && process.argv.at(-2) !== "--socket") process.exit(2);
const endpoint = process.argv.at(-1);
const path = endpoint?.startsWith("unix:")
  ? endpoint.slice(5)
  : endpoint?.startsWith("pipe:")
    ? endpoint.slice(5)
    : endpoint;
if (!path) throw new Error("Missing socket path");
const socket = connect(path);
socket.on("error", () => process.exit(1));
let sessionId = "test";
let sequence = 0;
let permissionQueries = 0;
let codec: "jpeg" | "h264" = "jpeg";
function frame(imageCodec = codec) {
  const payload = Buffer.from(`jpeg-${sequence}`);
  const packet = framePacket(
    v2
      ? {
          version: 2,
          sessionId,
          seq: sequence++,
          ts: 1000,
          width: Number(process.env.MODEL_FRAME_WIDTH ?? 100),
          height: Number(process.env.MODEL_FRAME_HEIGHT ?? 100),
          scale: Number(process.env.MODEL_NATIVE_SCALE ?? 1),
          codec: imageCodec,
          bytes: payload.length,
          dirtyRects: [{ x: 0, y: 0, w: 100, h: 100 }],
        }
      : {
          version: 1,
          sessionId,
          sequence: sequence++,
          timestamp: 1000,
          width: Number(process.env.MODEL_FRAME_WIDTH ?? 100),
          height: Number(process.env.MODEL_FRAME_HEIGHT ?? 100),
          scale: Number(process.env.MODEL_NATIVE_SCALE ?? 1),
          codec: imageCodec,
          bytes: payload.length,
        },
    payload,
  );
  // Split every header and payload across multiple writes.
  socket.write(packet.subarray(0, 2));
  socket.write(packet.subarray(2, 9));
  socket.write(packet.subarray(9));
}
let held: string | undefined;
let heldUI: string | undefined;
let inspectedInput = false;
const v2 = process.env.FAKE_V2 === "1";
let capturing = !v2;
let actions = 0;
let pointerHeld = false;
let failedCancel = false;
let pointerUps = 0;
let clickedTarget = "none";
const node = (ref: string, role: string, name: string, value?: string) => ({
  ref,
  role,
  name,
  value,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  states: [],
  actions: ["press", "setValue", "performSecondaryAction", "selectText"],
  secondaryActions: ["AXShowMenu"],
  children: [],
});
type FakeSession = { sequence: number; capturing: boolean; actions: number; clickedTarget: string };
const sessions = new Map<string, FakeSession>();
function saveSession() {
  if (sessions.has(sessionId))
    sessions.set(sessionId, { sequence, capturing, actions, clickedTarget });
}
function selectSession(id: string) {
  saveSession();
  sessionId = id;
  const state = sessions.get(id);
  if (state) {
    sequence = state.sequence;
    capturing = state.capturing;
    actions = state.actions;
    clickedTarget = state.clickedTarget;
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  if (request.op === "start")
    sessions.set(request.sessionId, {
      sequence: 0,
      capturing: request.capture ?? !v2,
      actions: 0,
      clickedTarget: "none",
    });
  if (request.sessionId) selectSession(request.sessionId);
  if (
    process.env.SECURE_TEXT === "1" &&
    ((request.op === "input" &&
      ["text.type", "text.paste", "key.press"].includes(request.input.kind)) ||
      (request.op === "ui.act" && request.ref === "field")) &&
    !request.secureInputAllowed
  ) {
    console.log(
      JSON.stringify({
        version: request.version,
        id: request.id,
        ok: false,
        error: { code: "secure_input_required", message: "Secure text requires session consent" },
      }),
    );
    return;
  }
  if (
    request.op === "input" &&
    process.env.IGNORE_POSTED === "1" &&
    request.mode !== "foreground"
  ) {
    console.log(
      JSON.stringify({
        version: request.version,
        id: request.id,
        ok: false,
        error: { code: "foreground_required", message: "App ignores background events" },
      }),
    );
    return;
  }
  if (request.op.startsWith("ui.") && process.env.ACCESS_DENIED === "1") {
    console.log(
      JSON.stringify({
        version: request.version,
        id: request.id,
        ok: false,
        error: { code: "permission_denied", message: "Accessibility denied" },
      }),
    );
    return;
  }
  let data: unknown;
  if (request.op === "hello" && v2)
    data = {
      version: 2,
      platform: "macos",
      background: true,
      maxSessions: 8,
      capture: { windows: true, displays: true, changeDriven: true },
      input: { pointer: true, keyboard: true, scroll: true, text: true },
      uiTree: true,
      semanticActions: [
        "press",
        "focus",
        "setValue",
        "scroll",
        "expand",
        "select",
        "performSecondaryAction",
        "selectText",
      ],
      codecs: process.env.FAKE_VIDEO === "1" ? ["jpeg", "h264"] : ["jpeg"],
      permissions: { screen: "granted", input: "granted" },
    };
  if (request.op === "hello" && process.env.BAD_CAPABILITIES === "1") data = { version: 99 };
  if (request.op === "stream.configure") {
    codec = request.settings.codec;
    data = { codec };
  }
  if (request.op === "stream.image") {
    if (!capturing) {
      data = { pending: true };
    } else frame("jpeg");
  }
  if (request.op === "capture") {
    data = { afterSeq: sequence };
    const starting = request.enabled && !capturing;
    capturing = request.enabled;
    if (starting) frame();
  }
  if (request.op === "stop") {
    capturing = false;
    sessions.delete(sessionId);
  }
  if (request.op === "ui.tree") {
    const root = node("root", "AXWindow", `host-${process.pid}`);
    const children = [
      node("button", "AXButton", "Click"),
      node(
        "field",
        process.env.SECURE_TEXT === "1" ? "AXSecureTextField" : "AXTextField",
        "Name",
        process.env.SECURE_TEXT === "1" ? undefined : String(actions),
      ),
    ];
    data = {
      nodes: [
        {
          ...root,
          children: request.maxDepth === 0 ? [] : children.slice(0, request.maxNodes - 1),
        },
      ],
      truncated: request.maxDepth === 0 || request.maxNodes < 3,
    };
  }
  if (request.op === "ui.tree" && process.env.BAD_TREE) {
    const root = { ...node("x", "", ""), bounds: { x: 0, y: 0, w: 0, h: 0 }, actions: [] };
    const nested: { children: unknown[] } = { ...root, children: [] };
    if (process.env.BAD_TREE === "nodes") nested.children = Array.from({ length: 512 }, () => root);
    else {
      let current = nested;
      for (let i = 0; i < 20; i++) {
        const child = { ...root, children: [] };
        current.children = [child];
        current = child;
      }
    }
    data = { nodes: [nested], truncated: false };
  }
  if (request.op === "ui.find")
    data = {
      nodes: [
        node("button", "AXButton", "Click"),
        node(
          "field",
          process.env.SECURE_TEXT === "1" ? "AXSecureTextField" : "AXTextField",
          "Name",
          process.env.SECURE_TEXT === "1" ? undefined : String(actions),
        ),
      ]
        .filter(
          (item) =>
            (!request.query.role || item.role.includes(request.query.role)) &&
            (!request.query.name || item.name.includes(request.query.name)) &&
            (!request.query.text ||
              `${item.name} ${item.value ?? ""}`.includes(request.query.text)),
        )
        .slice(0, request.limit),
      truncated: false,
    };
  if (request.op === "ui.act") {
    if (request.action === "performSecondaryAction" && request.name !== "AXShowMenu") {
      console.log(
        JSON.stringify({
          version: request.version,
          id: request.id,
          ok: false,
          error: { code: "not_supported", message: "Action is not advertised" },
        }),
      );
      return;
    }
    if (request.ref !== "button" && request.ref !== "field") {
      console.log(
        JSON.stringify({
          version: request.version,
          id: request.id,
          ok: false,
          error: { code: "target_gone", message: "Stale ref" },
        }),
      );
      return;
    }
    actions++;
    if (capturing) frame();
    data = { fallback: request.action === "expand", mode: request.mode ?? "background" };
  }
  if (request.op === "input") {
    if (
      request.input.kind === "pointer.cancel" &&
      process.env.FAIL_CANCEL_ONCE === "1" &&
      !failedCancel
    ) {
      failedCancel = true;
      console.log(
        JSON.stringify({
          version: request.version,
          id: request.id,
          ok: false,
          error: { code: "permission_denied", message: "Cleanup permission revoked" },
        }),
      );
      return;
    }
    actions++;
    if (request.input.kind === "pointer.down") pointerHeld = true;
    if (request.input.kind === "pointer.up" || request.input.kind === "pointer.cancel") {
      if (pointerHeld) pointerUps++;
      pointerHeld = false;
    }
    if (capturing) frame();
  }
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
      windows: [
        {
          windowId: 1,
          bundleId: "dev.ace.test",
          title: v2
            ? `capture:${capturing};actions:${actions};held:${Boolean(heldUI)};heldInput:${Boolean(held)};pointerHeld:${pointerHeld};pointerUps:${pointerUps};pid:${process.pid}`
            : process.env.MODEL_FRAME_WIDTH
              ? `Test;clicked:${clickedTarget}`
              : "Test",
        },
      ].concat(
        process.env.MULTI_TARGETS === "1"
          ? Array.from({ length: 8 }, (_, index) => ({
              windowId: index + 2,
              bundleId: `dev.ace.test${index + 2}`,
              title: "Other app",
            }))
          : [],
      ),
    };
  if (request.op === "targets" && process.env.NO_WINDOWS === "1")
    data = { displays: [], windows: [] };
  if (request.op === "open.app")
    data = { bundleId: request.bundleId, pid: process.pid, mode: "background" };
  if (request.op === "start") {
    sessionId = request.sessionId ?? "test";
    capturing = request.capture ?? !v2;
    if (capturing && process.env.INITIAL_FRAME === "1") frame();
  }
  if (request.op === "action") {
    if (request.action?.kind === "type" && request.action.text === "crash") {
      process.exit(7);
    }
    actions++;
    if (request.action?.kind === "click") {
      const nativeScale = Number(process.env.MODEL_NATIVE_SCALE ?? 1);
      const point = request.action.x / nativeScale;
      const pointY = request.action.y / nativeScale;
      clickedTarget =
        point === Number(process.env.MODEL_FRAME_WIDTH ?? 100) / nativeScale / 2 &&
        pointY === Number(process.env.MODEL_FRAME_HEIGHT ?? 100) / nativeScale / 2
          ? "centre"
          : "wrong";
    }
    if (capturing) frame();
    data = { action: request.action };
  }
  if (v2 && ["input", "action", "ui.act", "button.press"].includes(request.op)) {
    data = {
      fallback:
        request.op === "ui.act" ? request.action === "expand" : request.op !== "button.press",
      mode: request.mode ?? "background",
      snapshot: {
        nodes: [
          {
            ...node("root", "AXWindow", `host-${process.pid}`),
            children: [
              node("button", "AXButton", "Click"),
              node(
                "field",
                process.env.SECURE_TEXT === "1" ? "AXSecureTextField" : "AXTextField",
                "Name",
                process.env.SECURE_TEXT === "1" ? undefined : String(actions),
              ),
            ],
          },
        ],
        truncated: false,
      },
    };
  }
  saveSession();
  const reply = JSON.stringify({ version: request.version, id: request.id, ok: true, data });
  if (
    process.env.HOLD_PERMISSION === "1" &&
    request.op === "permissions" &&
    permissionQueries > 1
  ) {
    held = reply;
    inspectedInput = false;
    return;
  }
  if (process.env.REVERSE_REPLIES === "1" && request.op === "permissions") {
    held = reply;
    return;
  }
  if (request.op === "ui.tree" && process.env.HOLD_UI === "1") {
    heldUI = reply;
    return;
  }
  console.log(reply);
  if (request.op === "stop" && heldUI) {
    console.log(heldUI);
    heldUI = undefined;
  }
  if (held && process.env.HOLD_PERMISSION === "1" && !inspectedInput && request.op === "targets") {
    inspectedInput = true;
    return;
  }
  if (held) {
    console.log(held);
    held = undefined;
  }
});
lines.on("close", () => {
  socket.end();
});
