import { connect } from "node:net";
import { createInterface } from "node:readline";
import { ScreenHelperRequest } from "@ace/protocol";
import { framePacket } from "@ace/screen";

const endpoint = process.argv.at(-1);
if (!endpoint?.startsWith("unix:")) throw new Error("Expected a Unix frame endpoint");
const frames = connect(endpoint.slice(5));
frames.on("error", () => process.exit(1));
let sessionId = "not-started";
let sequence = 0;
let active = false;
const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const request = ScreenHelperRequest.parse(JSON.parse(line));
  let data: unknown;
  switch (request.op) {
    case "permissions":
      data = { screenRecording: true, accessibility: true };
      break;
    case "targets":
      data = {
        displays: [],
        windows: [{ windowId: 42, bundleId: "com.apple.iphonesimulator", title: "iPhone" }],
      };
      break;
    case "start":
      sessionId = request.sessionId;
      sequence = 0;
      active = true;
      break;
    case "stop":
      active = false;
      break;
    case "action": {
      if (!active) throw new Error("Simulator capture is stopped");
      const payload = Buffer.from("simulator-native-image");
      const packet = framePacket(
        {
          version: 1,
          sessionId,
          sequence: sequence++,
          timestamp: 123,
          width: 390,
          height: 844,
          codec: "jpeg",
          scale: 0.5,
          bytes: payload.length,
        },
        payload,
      );
      frames.write(packet.subarray(0, 2));
      frames.write(packet.subarray(2));
      break;
    }
  }
  process.stdout.write(
    JSON.stringify({ version: request.version, id: request.id, ok: true, data }) + "\n",
  );
});
commands.on("close", () => frames.end());
