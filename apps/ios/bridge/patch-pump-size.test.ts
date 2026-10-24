import { native } from "./test-host.ts";
import { expect, test } from "vitest";
import { PatchPump } from "./patch-pump.ts";

/*
 * The pump sizes each patch in UTF-8 through the host (`utf8Length`) and sends each frame as the
 * patches' own JSON: frames Swift receives stay within 32 KiB however wide the characters are.
 */

const frames: string[] = [];
const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const settle = async () => {
  for (let wait = 0; wait < 200 && native.frames.length < 41; wait++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

test("frames of wide characters stay within 32 KiB of UTF-8 and every patch arrives whole", async () => {
  const { aceHost } = globalThis;
  const emit = aceHost.emit;
  aceHost.emit = (frame) => {
    frames.push(frame);
    emit(frame);
  };
  // 3 bytes per character in UTF-8, 1 unit in UTF-16: 40 of these can't share one frame.
  for (let index = 0; index < 40; index++)
    pump.put(`row:${index}`, () => ({ type: "row", id: index, text: "€".repeat(1500) }));
  // Larger than a frame: it travels as fragments and is reassembled exactly.
  const wide = "😀".repeat(20_000);
  pump.put("big", () => ({ type: "big", text: wide }));
  await settle();
  aceHost.emit = emit;
  for (const frame of frames) expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(32768);
  expect(native.frames.filter((patch) => patch.type === "row")).toHaveLength(40);
  expect(native.frames.find((patch) => patch.type === "big")?.text).toBe(wide);
});
