// Offline native boundary. Valid screen packets and a one-time stop error only.
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { ScreenHelperRequest } from "@ace/protocol";
import { framePacket } from "@ace/screen";
const endpoint = process.argv.at(-1);
const marker = process.env["STOP_ERROR_MARKER"];
if (!endpoint?.startsWith("unix:") || !marker) throw new Error("Missing fake helper boundary");
const frames = connect(endpoint.slice(5));
frames.on("error", () => process.exit(1));
let sessionId = "not-started";
let sequence = 0;
const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  if (request.op === "stop" && !existsSync(marker)) {
    writeFileSync(marker, "rejected");
    process.stdout.write(
      JSON.stringify({
        version: request.version,
        id: request.id,
        ok: false,
        error: { code: "internal", message: "Simulator native stop rejected" },
      }) + "\n",
    );
    return;
  }
  if (request.op === "start") {
    sessionId = request.sessionId;
    sequence = 0;
  }
  const data =
    request.op === "hello"
      ? {
          version: 2,
          platform: "macos",
          capture: { windows: true, displays: false, changeDriven: true },
          input: { pointer: true, keyboard: true, scroll: true, text: true },
          uiTree: false,
          semanticActions: [],
          codecs: ["jpeg"],
          permissions: { screen: "granted", input: "granted" },
        }
      : request.op === "capture"
        ? { afterSeq: sequence }
        : request.op === "permissions"
          ? { screenRecording: true, accessibility: true }
          : request.op === "targets"
            ? {
                displays: [],
                windows: [{ windowId: 42, bundleId: "com.apple.iphonesimulator", title: "iPhone" }],
              }
            : undefined;
  process.stdout.write(
    JSON.stringify({ version: request.version, id: request.id, ok: true, data }) + "\n",
  );
  if (request.op === "capture" && request.enabled) {
    const payload = Buffer.from("simulator-frame");
    frames.write(
      framePacket(
        {
          version: 1,
          sessionId,
          sequence: sequence++,
          timestamp: 0,
          width: 390,
          height: 844,
          codec: "jpeg",
          bytes: payload.length,
        },
        payload,
      ),
    );
  }
});
commands.on("close", () => frames.end());
