import { expect, it } from "vitest";
import type { MediaCapabilityEntry } from "./acceleration.ts";
import { pictureCodecs, pictureEncoders } from "./picture-codecs.ts";

const encode = (
  codec: string,
  backend: MediaCapabilityEntry["backend"],
  over: Partial<MediaCapabilityEntry> = {},
): MediaCapabilityEntry => ({
  step: "encode",
  codec,
  backend,
  hardware: backend !== "chrome",
  zeroCopy: false,
  state: "ok",
  maxWidth: 4096,
  maxHeight: 2304,
  ...over,
});

it("a machine whose VA-API encodes work is offered only what ace-media builds there", () => {
  const probed = [
    encode("hvc1.1.6.L120.B0", "vaapi"),
    encode("avc1.640028", "vaapi"),
    encode("avc1.42E01F", "chrome"),
  ];
  // ace-media's JPEG encoder can't construct a VA-API encoder: H.264 comes from the last resort.
  expect(pictureCodecs(probed, pictureEncoders("linux"))).toEqual(["avc1.42E01F"]);
});

it("a Mac is offered each family VideoToolbox encodes, H.264 first", () => {
  const probed = [encode("hvc1.1.6.L120.B0", "vt"), encode("avc1.640028", "vt")];
  expect(pictureCodecs(probed, pictureEncoders("darwin"))).toEqual([
    "avc1.640028",
    "hvc1.1.6.L120.B0",
  ]);
});

it("a trial that failed, or a software session, is never offered", () => {
  const probed = [
    encode("avc1.640028", "vt", { state: "timed-out", hardware: false }),
    encode("hvc1.1.6.L120.B0", "vt", { hardware: false }),
    encode("hvc1.1.6.L120.B0", "chrome"),
  ];
  expect(pictureCodecs(probed, pictureEncoders("darwin"))).toEqual([]);
});

it("a platform the table doesn't know builds no hardware encoder", () => {
  expect(pictureEncoders("aix")).toEqual([]);
  expect(pictureCodecs([encode("avc1.640028", "mf")], pictureEncoders("win32"))).toEqual([]);
});
