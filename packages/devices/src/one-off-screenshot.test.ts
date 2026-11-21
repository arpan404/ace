import { ImageError, unavailableImages, type ImageWork } from "@ace/media/images";
import { expect, it } from "vitest";
import { shotJpeg } from "./one-off-screenshot.ts";

/* ADR 0208 §6: a screenshot whose image job can't run fails at once, saying why. */

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

it("with ace-media unavailable a screenshot fails at once with the reason, not a hang", async () => {
  const error = await shotJpeg(png, unavailableImages("no ace-media binary was found")).catch(
    (e: unknown) => e,
  );
  expect(error).toMatchObject({
    code: "tool_missing",
    message: expect.stringContaining("no ace-media binary was found"),
  });
});

it("a picture ace-media refuses as cut short fails as invalid data with its sentence", async () => {
  const refusing: ImageWork = {
    run: () =>
      Promise.reject(new ImageError("truncated", "The PNG ends early: the image is incomplete.")),
  };
  await expect(shotJpeg(png, refusing)).rejects.toMatchObject({
    code: "invalid_data",
    message: expect.stringContaining("ends early"),
  });
});

it("a slow or busy ace-media is a timeout or busy the agent may retry", async () => {
  for (const [reason, code] of [
    ["deadline", "timeout"],
    ["busy", "busy"],
  ] as const) {
    const work: ImageWork = { run: () => Promise.reject(new ImageError(reason, "later")) };
    await expect(shotJpeg(png, work)).rejects.toMatchObject({ code });
  }
});

it("a fitted screenshot reports its scale against the stored width", async () => {
  const work: ImageWork = {
    run: async () => ({
      width: 972,
      height: 2160,
      format: "jpeg",
      source: { format: "png", width: 1080, height: 2400, orientation: 1 },
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    }),
  };
  expect(await shotJpeg(png, work)).toMatchObject({ width: 972, height: 2160, scale: 0.9 });
});
