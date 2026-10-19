import { expect, it } from "vitest";
import { AvccRecords, annexB, avcConfig, type AvccRecord } from "./simulator-avcc.ts";
import { spsDimensions } from "./h264-sps.ts";

// The decoder configuration serve-sim 0.1.48 sent for an iPhone 16 Pro (High 5.1, 1206×2622).
const description = Buffer.from(
  "01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0",
  "hex",
);
const record = (tag: number, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = tag;
  return Buffer.concat([head, body]);
};
const sample = (...nals: Buffer[]) =>
  Buffer.concat(
    nals.flatMap((nal) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(nal.length);
      return [length, nal];
    }),
  );
const idr = Buffer.from([0x25, 0xb8, 0x00, 0x40, 0x01]);
const slice = Buffer.from([0x21, 0x9a, 0x02]);
const stream = Buffer.concat([
  record(4, Buffer.from("jpeg seed")),
  record(1, description),
  record(2, sample(idr)),
  record(3, sample(slice)),
  record(9, Buffer.from([7])),
]);

it("stream records come out whole however the bytes are split, unknown tags kept raw", () => {
  const whole: AvccRecord[] = [];
  new AvccRecords((value) => whole.push(value)).push(stream);
  const split: AvccRecord[] = [];
  const reader = new AvccRecords((value) => split.push(value));
  for (const byte of stream) reader.push(Buffer.from([byte]));
  const shape = (records: AvccRecord[]) =>
    records.map((value) => [
      value.kind,
      value.kind === "other" ? value.tag : 0,
      value.body.toString("hex"),
    ]);
  expect(shape(split)).toEqual(shape(whole));
  expect(shape(whole)).toEqual([
    ["other", 4, Buffer.from("jpeg seed").toString("hex")],
    ["description", 0, description.toString("hex")],
    ["key", 0, sample(idr).toString("hex")],
    ["delta", 0, sample(slice).toString("hex")],
    ["other", 9, "07"],
  ]);
});

it("an empty or oversized record is refused rather than buffered", () => {
  expect(() => new AvccRecords(() => {}).push(Buffer.from([0, 0, 0, 0, 1]))).toThrow("invalid");
  expect(() => new AvccRecords(() => {}).push(Buffer.from([0x7f, 0, 0, 0, 2]))).toThrow("invalid");
});

it("serve-sim's description names the High profile codec and the cropped screen size", () => {
  expect(avcConfig(description)).toMatchObject({
    codec: "avc1.640033",
    lengthSize: 4,
    width: 1206,
    height: 2622,
  });
});

it("a keyframe becomes Annex B led by SPS and PPS; a delta carries only its slices", () => {
  const config = avcConfig(description);
  const start = "00000001";
  const sps = "27640033ac13143c04c0149e6a9a81010103c20108f8";
  const pps = "28ee3cb0";
  expect(annexB(sample(idr), config, true).toString("hex")).toBe(
    `${start}${sps}${start}${pps}${start}${idr.toString("hex")}`,
  );
  expect(annexB(sample(slice, idr), config, false).toString("hex")).toBe(
    `${start}${slice.toString("hex")}${start}${idr.toString("hex")}`,
  );
  expect(() => annexB(sample(idr).subarray(0, 6), config, false)).toThrow("truncated");
});

it("picture size honours frame cropping for 4:2:0 and 4:4:4 parameter sets", () => {
  // Parameter sets x264 wrote for 1920×1080 Baseline, 640×360 High and 1280×720 High 4:4:4.
  for (const [hex, width, height] of [
    ["6742c028d900780227e5c044000003000400000300c83c60c920", 1920, 1080],
    ["6764001eacd940a02ff97011000003000100000300320f162d96", 640, 360],
    ["67f4001f919b280a00b76022000003000200000300641e30632c", 1280, 720],
  ] as const)
    expect(spsDimensions(Buffer.from(hex, "hex"))).toEqual({ width, height });
  expect(() => spsDimensions(Buffer.from("6764", "hex"))).toThrow("Truncated");
});
