import { expect, it } from "vitest";
import { maxModelImageBytes } from "./result-budgets.ts";
import { modelImage, type ModelImageRuntime } from "./index.ts";

const frame = { payload: Buffer.from("fake image"), width: 3072, height: 1536 };
const signal = () => new AbortController().signal;
const runtime = (fit: ModelImageRuntime["fit"]): ModelImageRuntime => ({
  fit,
  after: () => () => {},
});

it("a screenshot the resize rejects fails with the fixed public remedy, never its diagnostics", async () => {
  const failed = modelImage(
    frame,
    signal(),
    runtime(async () => {
      throw new Error("decoder said /secret/path is corrupt");
    }),
  );
  await expect(failed).rejects.toMatchObject({ code: "screenshot_failed" });
  await expect(failed).rejects.not.toMatchObject({ message: expect.stringContaining("secret") });
});

it("a busy screen is encoded again at lower quality until it fits the model's byte budget", async () => {
  const asked: number[] = [];
  const image = await modelImage(
    frame,
    signal(),
    runtime(async (_input, box, quality) => {
      asked.push(quality);
      const bytes = Buffer.alloc(quality > 40 ? maxModelImageBytes + 1 : 1000);
      return { bytes, width: box.width, height: box.height };
    }),
  );
  expect(asked).toEqual([85, 60, 40]);
  expect(image).toMatchObject({ width: 1536, height: 768, scale: 0.5 });
  expect(image.payload.length).toBe(1000);
});

it("a screen too busy for the budget at every quality fails", async () => {
  await expect(
    modelImage(
      frame,
      signal(),
      runtime(async (_input, box) => ({
        bytes: Buffer.alloc(maxModelImageBytes + 1),
        width: box.width,
        height: box.height,
      })),
    ),
  ).rejects.toMatchObject({ code: "screenshot_failed" });
});

it("the injected deadline fails a stalled resize at once", async () => {
  const deadline = Promise.withResolvers<() => void>();
  const result = modelImage(frame, signal(), {
    fit: () => new Promise(() => {}),
    after: (_milliseconds, expire) => {
      deadline.resolve(expire);
      return () => {};
    },
  });
  const rejected = expect(result).rejects.toMatchObject({ code: "screenshot_failed" });
  (await deadline.promise)();
  await rejected;
});
