import { spawn } from "node:child_process";
import { expect, it, onTestFinished } from "vitest";
import { computerUseHandler } from "./index.ts";
import { manager, ready } from "./testing/support.ts";

it.each([1, 2])(
  "a legacy model screenshot midpoint clicks the captured target centre at native scale %s",
  async (scale) => {
    const f = await manager(
      {
        INITIAL_FRAME: "1",
        MODEL_FRAME_WIDTH: "3072",
        MODEL_FRAME_HEIGHT: "1536",
        MODEL_NATIVE_SCALE: String(scale),
      },
      {
        modelImageRuntime: {
          encoder: async () => process.execPath,
          spawn: () =>
            spawn(
              process.execPath,
              [
                "-e",
                "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([255,216,255,217])))",
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            ),
          after: () => () => {},
        },
      },
    );
    onTestFinished(f.close);
    const state = await ready(f.screen);
    f.screen.controller(state.sessionId, "agent", "agent");
    const tool = computerUseHandler(f.screen, state.sessionId, "agent");
    const result = await tool("screen_screenshot", {});
    expect(result.content).toMatchObject([
      { type: "image" },
      { type: "text", text: expect.stringContaining("1536x768 model image") },
    ]);
    await tool("screen_click", { x: 768, y: 384 });
    expect((await f.screen.targets()).windows[0]?.title).toContain("clicked:centre");
    f.screen.controller(state.sessionId, "human", "person");
    f.screen.controller(state.sessionId, "agent", "agent");
    await expect(tool("screen_click", { x: 768, y: 384 })).rejects.toMatchObject({
      code: "screenshot_required",
    });
  },
);
