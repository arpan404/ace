import { createInterface } from "node:readline";
import { ScreenHelperRequestV2 } from "@ace/protocol";

// No frame endpoint: a service session can answer only through its inherited stdio.
const reason = "Run ace in your signed-in session, not as a service in session 0.";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = ScreenHelperRequestV2.parse(JSON.parse(line));
  let data: unknown;
  let error: unknown;
  if (request.op === "hello") {
    data = {
      version: 2,
      platform: "windows",
      inspectionOnly: true,
      capture: { windows: false, displays: false, changeDriven: false },
      input: { pointer: false, keyboard: false, scroll: false, text: false },
      uiTree: false,
      semanticActions: [],
      codecs: ["jpeg"],
      permissions: { screen: "denied", input: "denied" },
    };
  } else if (request.op === "permissions" || request.op === "permissions.request") {
    data = {
      platform: "win32",
      screenRecording: false,
      accessibility: false,
      requirements: [
        {
          kind: "interactiveDesktop",
          state: "blocked",
          title: "Interactive Windows desktop",
          message: reason,
        },
      ],
    };
  } else error = { code: "permission_denied", message: reason };
  process.stdout.write(
    `${JSON.stringify({ version: 2, id: request.id, ok: !error, data, error })}\n`,
  );
});
