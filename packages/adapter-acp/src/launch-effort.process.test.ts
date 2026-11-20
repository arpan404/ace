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

/** A live session on the scripted agent, with the native modes it announced on its own. */
async function live(serverArgs: string[], context: { permissionMode?: string; model?: string }) {
  const frames: Frame[] = [];
  const announced: string[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("selection-replies"),
      cwd: process.cwd(),
      ...context,
      signal: new AbortController().signal,
      onFrame(frame) {
        frames.push(frame);
      },
      onPermissionMode(native) {
        announced.push(native);
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
  const selected = (configId: string) =>
    frames
      .filter(
        (frame) =>
          frame.dir === "send" && object(object(frame.data)["params"])["configId"] === configId,
      )
      .map((frame) => object(object(frame.data)["params"])["value"]);
  return { session, frames, announced, selected };
}

test("a mode the agent answers with another one is refused, and the session reports what runs", async () => {
  const { session } = await live(["--mode", "--ignore-mode"], {});
  try {
    await expect(session.setMode?.("yolo")).rejects.toThrow("not applied");
    expect(session.permissionMode).toBe("default");
  } finally {
    await session.close("shutdown");
  }
});

test("an effort the agent answers with another level is reported as not taken", async () => {
  expect((await open("deep", "max", ["--ignore-thinking"])).refused).toEqual(["effort"]);
});

test("a saved model and mode the agent no longer lists still open, and say they didn't apply", async () => {
  const { session } = await live(["--mode"], { permissionMode: "gone", model: "retired" });
  try {
    expect(session.refusedOptions).toEqual(["permissionMode", "model"]);
    expect(session.permissionMode).toBe("default");
  } finally {
    await session.close("shutdown");
  }
});

test("a mode set through session/set_mode is what the session reports running", async () => {
  const { session } = await live(["--legacy-mode"], { permissionMode: "plan" });
  try {
    expect(session.refusedOptions).toEqual([]);
    expect(session.permissionMode).toBe("plan");
  } finally {
    await session.close("shutdown");
  }
});

test("an agent that leaves plan mode on its own says so, and the session reports the new mode", async () => {
  const { session, announced } = await live(["--legacy-mode", "--leave-plan"], {
    permissionMode: "plan",
  });
  try {
    expect(announced).toEqual([]);
    await session.send([{ type: "text", text: "work" }], "queue");
    await expect.poll(() => announced).toEqual(["default"]);
    expect(session.permissionMode).toBe("default");
    expect(session.effectiveCapabilities?.planMode).toBe(true);
  } finally {
    await session.close("shutdown");
  }
});

test("a model changed in a live session gets back the mode its reply reset", async () => {
  const { session, selected, announced } = await live(["--mode"], { permissionMode: "yolo" });
  try {
    await session.setModel?.("deep");
    expect(selected("mode")).toEqual(["yolo", "yolo"]);
    expect(session.permissionMode).toBe("yolo");
    expect(announced).toEqual([]);
  } finally {
    await session.close("shutdown");
  }
});

test("mode changes asked back to back both reach the agent, in order", async () => {
  const { session, selected } = await live(["--mode"], {});
  try {
    await Promise.all([session.setMode?.("yolo"), session.setMode?.("default")]);
    expect(selected("mode")).toEqual(["yolo", "default"]);
    expect(session.permissionMode).toBe("default");
  } finally {
    await session.close("shutdown");
  }
});
