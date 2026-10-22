import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, genericQuirks } from "./index.ts";
import { object } from "./data.ts";

/** Open a session on the scripted agent and return the config selections ace sent it. */
async function selectionsAt(
  model: string,
  effort: string,
  serverArgs: string[] = [],
): Promise<unknown[]> {
  const frames: Frame[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("launch-effort"),
      cwd: process.cwd(),
      model,
      options: { effort },
      signal: new AbortController().signal,
      onFrame(frame) {
        frames.push(frame);
      },
      onExit() {},
    },
    genericQuirks,
    {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./testing/thinking-server.ts", import.meta.url)),
        ...serverArgs,
      ],
    },
  );
  await session.close("shutdown");
  return frames
    .filter(
      (frame) =>
        frame.dir === "send" && object(frame.data)["method"] === "session/set_config_option",
    )
    .map((frame) => {
      const params = object(object(frame.data)["params"]);
      return [params["configId"], params["value"]];
    });
}

test("a new ACP session starts at the chosen effort, from the selected model's own levels", async () => {
  // "max" exists only on the deep model, so it can be set only after the model is.
  expect(await selectionsAt("deep", "max")).toEqual([
    ["model", "deep"],
    ["thinking", "max"],
  ]);
});

test("an effort the agent doesn't offer for the model leaves the session at its default", async () => {
  expect(await selectionsAt("fast", "max")).toEqual([["model", "fast"]]);
});

test("an agent that refuses the thinking level still starts, at its own default", async () => {
  expect(await selectionsAt("deep", "max", ["--refuse-thinking"])).toEqual([
    ["model", "deep"],
    ["thinking", "max"],
  ]);
});
