import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
import { framePacket } from "@ace/screen";

/**
 * A macOS screen helper speaking protocol v2, standing in for AceScreenHelper.app: it lists one
 * Simulator window, streams a frame when capture is leased and another after each input, and
 * reads its macOS permissions from HELPER_PERMISSIONS (a JSON file) on every check, so a test
 * can grant one while ace is running. Inputs and permission requests go to HELPER_JOURNAL.
 */
const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Expected a Unix frame endpoint");
const journal = process.env["HELPER_JOURNAL"] ?? "";
const permissionsFile = process.env["HELPER_PERMISSIONS"] ?? "";
const windowTitle = process.env["HELPER_WINDOW"] ?? "iPhone";
const frames = connect(endpoint.slice(5));
frames.on("error", () => process.exit(1));
let sessionId = "";
let sequence = 0;
let capturing = false;
let heldPointer = false;
/** HELPER_VIDEO=off stands in for a Mac whose helper can't encode H.264. */
const video = process.env["HELPER_VIDEO"] !== "off";
let codec: "jpeg" | "h264" = "jpeg";
let screen = "home";

const permissions = (): {
  screenRecording: boolean;
  accessibility: boolean;
  /** Simulator is the frontmost app; window keys are dropped otherwise. */
  frontmost?: boolean;
} => JSON.parse(readFileSync(permissionsFile, "utf8"));
const record = (entry: unknown) => appendFileSync(journal, `${JSON.stringify(entry)}\n`);
/** One picture of `next`: a JPEG, or once video is asked for, a stand-in H.264 keyframe. */
function paint(next: string) {
  screen = next;
  if (!capturing) return;
  const payload = Buffer.from(`simulator:${next}`);
  frames.write(
    framePacket(
      {
        version: 2,
        sessionId,
        seq: sequence++,
        ts: 1,
        width: 780,
        height: 1688,
        scale: 2,
        codec,
        ...(codec === "h264" ? { keyframe: true, videoCodec: "avc1.42E01F" } : {}),
        bytes: payload.length,
      },
      payload,
    ),
  );
}

const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  let data: unknown;
  let error: { code: string; message: string } | undefined;
  switch (request.op) {
    case "hello":
      data = {
        version: 2,
        platform: "macos",
        capture: { windows: true, displays: true, changeDriven: true },
        input: { pointer: true, keyboard: true, scroll: true, text: true },
        uiTree: false,
        semanticActions: [],
        codecs: video ? ["jpeg", "h264"] : ["jpeg"],
        permissions: { screen: "granted", input: "granted" },
      };
      break;
    case "permissions": {
      const { screenRecording, accessibility } = permissions();
      data = { screenRecording, accessibility };
      break;
    }
    case "permissions.request": {
      record({ requested: request.permission });
      const { screenRecording, accessibility } = permissions();
      data = { screenRecording, accessibility };
      break;
    }
    case "targets":
      if (!permissions().screenRecording)
        error = { code: "permission_denied", message: "Screen Recording permission denied" };
      else
        data = {
          displays: [],
          windows: [{ windowId: 42, bundleId: "com.apple.iphonesimulator", title: windowTitle }],
        };
      break;
    case "start":
      sessionId = request.sessionId;
      codec = "jpeg";
      sequence = 0;
      break;
    case "capture":
      capturing = request.enabled;
      data = { afterSeq: sequence };
      setTimeout(() => paint("home"), 5);
      break;
    case "stop":
      capturing = false;
      break;
    case "stream.configure":
      codec = request.settings.codec;
      data = { codec };
      setTimeout(() => paint(screen), 5);
      break;
    case "stream.keyframe":
      setTimeout(() => paint(screen), 5);
      break;
    case "button.press":
      if (!permissions().accessibility)
        error = { code: "permission_denied", message: "macOS permission denied" };
      else {
        record({ button: request.name });
        setTimeout(() => paint(`after-${request.name}`), 5);
      }
      break;
    case "input":
      if (!permissions().accessibility)
        error = { code: "permission_denied", message: "macOS permission denied" };
      else if (
        ["text.type", "key.press"].includes(request.input.kind) &&
        permissions().frontmost === false &&
        !request.humanDeviceInput
      )
        error = {
          code: "not_supported",
          message: "Keys reach Simulator only while it is the frontmost app",
        };
      else {
        if (request.input.kind === "pointer.down") heldPointer = true;
        if (["pointer.up", "pointer.cancel"].includes(request.input.kind) && heldPointer) {
          record({ nativeMouseUp: { windowId: 42, button: "left" } });
          heldPointer = false;
        }
        record({ input: request.input });
        setTimeout(() => paint(`after-${request.input.kind}`), 5);
      }
      break;
  }
  process.stdout.write(
    `${JSON.stringify({ version: request.version, id: request.id, ok: !error, ...(error ? { error } : { data }) })}\n`,
  );
});
commands.on("close", () => frames.end());
