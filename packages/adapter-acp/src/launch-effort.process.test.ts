import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, genericQuirks } from "./index.ts";
import { object } from "./data.ts";

/** Open a session on the scripted agent: the config selections ace sent it, and what it refused. */
async function open(
  model: string,
  effort: string,
  serverArgs: string[] = [],
  permissionMode?: string,
): Promise<{ selections: unknown[]; refused: readonly string[] | undefined }> {
  const frames: Frame[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("launch-effort"),
      cwd: process.cwd(),
      model,
      ...(permissionMode ? { permissionMode } : {}),
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
  const selections = frames
    .filter(
      (frame) =>
        frame.dir === "send" && object(frame.data)["method"] === "session/set_config_option",
    )
    .map((frame) => {
      const params = object(object(frame.data)["params"]);
      return [params["configId"], params["value"]];
    });
  return { selections, refused: session.refusedOptions };
}
async function selectionsAt(model: string, effort: string, serverArgs: string[] = []) {
  return (await open(model, effort, serverArgs)).selections;
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

test("a session tells the daemon which effort it didn't take, so the thread stops showing it", async () => {
  expect((await open("deep", "max")).refused).toEqual([]);
  expect((await open("fast", "max")).refused).toEqual(["effort"]);
  expect((await open("deep", "max", ["--refuse-thinking"])).refused).toEqual(["effort"]);
});

test("a model whose reply resets the permission mode gets the chosen mode back", async () => {
  const { selections } = await open("deep", "max", ["--mode"], "yolo");
  expect(selections).toEqual([
    ["mode", "yolo"],
    ["model", "deep"],
    ["mode", "yolo"],
    ["thinking", "max"],
  ]);
});

test("a running turn takes a new permission mode at once", async () => {
  const frames: Frame[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("mid-turn-mode"),
      cwd: process.cwd(),
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
        "--mode",
        "--hold-prompt",
      ],
    },
  );
  try {
    const sent = (method: string) =>
      frames.some((frame) => frame.dir === "send" && object(frame.data)["method"] === method);
    const turn = session.send([{ type: "text", text: "work" }], "queue");
    await expect.poll(() => sent("session/prompt")).toBe(true);
    // The agent holds the turn open until the mode changes, so this lands mid-turn.
    await session.setMode?.("yolo");
    // The held turn ends only once the agent took the mode.
    await turn;
    const modes = frames.filter(
      (frame) =>
        frame.dir === "send" && object(object(frame.data)["params"])["configId"] === "mode",
    );
    expect(modes.map((frame) => object(object(frame.data)["params"])["value"])).toEqual(["yolo"]);
  } finally {
    await session.close("shutdown");
  }
});
