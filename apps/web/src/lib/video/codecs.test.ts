import { afterEach, expect, test, vi } from "vitest";
import { webCodecsDecoder, type DecoderPreference } from "./codecs.ts";

/**
 * A stand-in platform decoder. `hint`: what it does with `prefer-hardware` (take it, refuse the
 * configuration at once, or fail the first decode); `codec`: whether it decodes at all.
 */
function platform(hint: "takes" | "refuses" | "fails", codec: "decodes" | "unsupported") {
  const configs: { hardwareAcceleration?: string }[] = [];
  type Handlers = { output(frame: unknown): void; error(failure: DOMException): void };
  class Decoder {
    state = "unconfigured";
    #handlers: Handlers;
    #hinted = false;
    constructor(handlers: Handlers) {
      this.#handlers = handlers;
    }
    configure(config: { hardwareAcceleration?: string }) {
      configs.push(config);
      this.#hinted = config.hardwareAcceleration === "prefer-hardware";
      if (this.#hinted && hint === "refuses") throw new TypeError("hardwareAcceleration");
      this.state = "configured";
    }
    decode(chunk: { timestamp: number }) {
      queueMicrotask(() => {
        if (codec === "unsupported")
          return this.#handlers.error(new DOMException("no codec", "NotSupportedError"));
        if (this.#hinted && hint === "fails")
          return this.#handlers.error(new DOMException("hardware gone", "EncodingError"));
        this.#handlers.output({ timestamp: chunk.timestamp, close() {} });
      });
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      timestamp: number;
      constructor(init: { timestamp: number }) {
        this.timestamp = init.timestamp;
      }
    },
  );
  return configs;
}
afterEach(() => vi.unstubAllGlobals());

const config = { codec: "avc1.640033", codedWidth: 1280, codedHeight: 800 };
const keyframe = { key: true, sequence: 1, bytes: new Uint8Array([1]) };

/** Runs one decoder from `factory` over a keyframe: what it showed, and how it failed. */
async function decodeOnce(factory: NonNullable<ReturnType<typeof webCodecsDecoder>>) {
  const shown: number[] = [];
  const errors: boolean[] = [];
  const decoder = factory({
    output: (picture) => shown.push(picture.sequence),
    error: (unsupported) => errors.push(unsupported === true),
  });
  decoder.configure(config);
  decoder.decode(keyframe);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { shown, errors };
}

test("each decoder asks for hardware, and a platform that takes the hint decodes with it", async () => {
  const configs = platform("takes", "decodes");
  const said: DecoderPreference[] = [];
  const factory = webCodecsDecoder((preference) => said.push(preference));
  expect(await decodeOnce(factory!)).toEqual({ shown: [1], errors: [] });
  expect(configs.map((entry) => entry.hardwareAcceleration)).toEqual(["prefer-hardware"]);
  expect(said).toEqual(["hardware"]);
});

test("a refused hardware hint falls back to the browser's default at once and still decodes", async () => {
  const configs = platform("refuses", "decodes");
  const said: [DecoderPreference, string | undefined][] = [];
  const factory = webCodecsDecoder((preference, reason) => said.push([preference, reason]));
  expect(await decodeOnce(factory!)).toEqual({ shown: [1], errors: [] });
  expect(configs.map((entry) => entry.hardwareAcceleration)).toEqual([
    "prefer-hardware",
    undefined,
  ]);
  expect(said).toEqual([["default", "TypeError"]]);
});

test("a hardware decoder failing before its first picture is recoverable, and the next one runs without the hint", async () => {
  const configs = platform("fails", "decodes");
  const said: [DecoderPreference, string | undefined][] = [];
  const factory = webCodecsDecoder((preference, reason) => said.push([preference, reason]));
  // Not "unsupported": the stream asks for a keyframe and starts a new decoder.
  expect(await decodeOnce(factory!)).toEqual({ shown: [], errors: [false] });
  expect(await decodeOnce(factory!)).toEqual({ shown: [1], errors: [] });
  expect(configs.map((entry) => entry.hardwareAcceleration)).toEqual([
    "prefer-hardware",
    undefined,
  ]);
  expect(said).toEqual([
    ["hardware", undefined],
    ["default", "EncodingError"],
  ]);
});

test("a codec the platform can't decode at all is unsupported after one fallback, never retried with the hint", async () => {
  const configs = platform("takes", "unsupported");
  const factory = webCodecsDecoder();
  expect(await decodeOnce(factory!)).toEqual({ shown: [], errors: [false] });
  expect(await decodeOnce(factory!)).toEqual({ shown: [], errors: [true] });
  expect(await decodeOnce(factory!)).toEqual({ shown: [], errors: [true] });
  expect(configs.map((entry) => entry.hardwareAcceleration)).toEqual([
    "prefer-hardware",
    undefined,
    undefined,
  ]);
});
