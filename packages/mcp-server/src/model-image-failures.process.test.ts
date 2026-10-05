import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { modelImage, type ModelImageRuntime } from "./index.ts";
const frame = { payload: Buffer.from("fake image"), width: 3072, height: 1536 };
const signal = () => new AbortController().signal;
const runtime: ModelImageRuntime = {
  encoder: async () => process.execPath,
  spawn: () =>
    spawn(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))"],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  after: () => () => {},
};
it("a missing encoder returns a fixed public screenshot remedy", async () => {
  await expect(
    modelImage(frame, signal(), { ...runtime, encoder: async () => undefined }),
  ).rejects.toMatchObject({ code: "screenshot_failed", hint: expect.stringContaining("ffmpeg") });
});
it("a rejecting encoder cannot expose diagnostics or leave a successful image", async () => {
  await expect(modelImage(frame, signal(), runtime)).rejects.toMatchObject({
    code: "screenshot_failed",
  });
});
it("the injected deadline kills a stalled encoder and releases its child", async () => {
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const deadline = Promise.withResolvers<() => void>();
  const result = modelImage(frame, signal(), {
    ...runtime,
    after: (_milliseconds, expire) => {
      deadline.resolve(expire);
      return () => {};
    },
    spawn: () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.once("spawn", () => started.resolve());
      child.once("close", () => closed.resolve());
      return child;
    },
  });
  const rejected = expect(result).rejects.toMatchObject({ code: "screenshot_failed" });
  await started.promise;
  (await deadline.promise)();
  await rejected;
  await closed.promise;
});
