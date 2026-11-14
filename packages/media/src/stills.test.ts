import { expect, it } from "vitest";
import { MediaStills, stillRoute, type StillRequest } from "./stills.ts";
import { legacyMediaSettings, type MediaHealth, type MediaSettings } from "./supervision-policy.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import type { ToMedia } from "./wire.ts";

const auto: MediaSettings = { ...legacyMediaSettings, stills: "auto" };
const request: StillRequest = {
  source: "s1",
  maxWidth: 1568,
  maxHeight: 1568,
  maxPixels: 1_150_000,
  quality: 80,
  deadlineMs: 500,
};
const steps = [
  { step: "decode", backend: "vt", hardware: true, readbacks: 0, uploads: 0 },
  { step: "scale", backend: "vt", hardware: true, readbacks: 0, uploads: 0 },
  { step: "jpeg-encode", backend: "vt", hardware: true, readbacks: 0, uploads: 0 },
] as const;

function stills(options: { settings?: MediaSettings; health?: MediaHealth; up?: boolean } = {}) {
  const clock = new ManualClock();
  const sent: ToMedia[] = [];
  let next = 0;
  let legacyCalls = 0;
  const media = new MediaStills({
    settings: () => options.settings ?? auto,
    health: () => options.health ?? "healthy",
    send: (message) => {
      if (options.up === false) return false;
      sent.push(message);
      return true;
    },
    clock,
    nextId: () => `still-${++next}`,
  });
  const take = () =>
    media.take(
      request,
      async () => {
        legacyCalls++;
        return "legacy";
      },
      (still) =>
        `ace-media ${still.width}x${still.height} ${still.jpeg.length}B ${still.steps.length} steps`,
    );
  return { media, clock, sent, take, legacyCalls: () => legacyCalls };
}

it("routes a still to ace-media only when the setting is auto and ace-media is healthy", () => {
  expect(stillRoute(legacyMediaSettings, "healthy")).toBe("legacy");
  expect(stillRoute(auto, "healthy")).toBe("ace-media");
  expect(stillRoute(auto, "restarting")).toBe("legacy");
  expect(stillRoute(auto, "unavailable")).toBe("legacy");
});

it("leaves stills to the legacy maker by default, sending nothing to ace-media", async () => {
  const { take, sent, legacyCalls } = stills({ settings: legacyMediaSettings });
  await expect(take()).resolves.toBe("legacy");
  expect(sent).toEqual([]);
  expect(legacyCalls()).toBe(1);
});

it("answers with ace-media's JPEG and its path when still.done arrives in time", async () => {
  const { media, take, sent, legacyCalls } = stills();
  const still = take();
  expect(sent).toEqual([{ type: "still.take", request: "still-1", ...request }]);
  const payload = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  media.message(
    { type: "still.done", request: "still-1", width: 722, height: 1568, steps: [...steps] },
    payload,
  );
  // The supervisor may reuse its buffer afterwards; the still keeps its own copy.
  payload.fill(0);
  await expect(still).resolves.toBe("ace-media 722x1568 6B 3 steps");
  expect(legacyCalls()).toBe(0);
  expect(media.pending).toBe(0);
});

it("falls back to the legacy maker when ace-media fails the still", async () => {
  const { media, take } = stills();
  const still = take();
  media.message(
    { type: "still.failed", request: "still-1", reason: "decode-unavailable" },
    new Uint8Array(),
  );
  await expect(still).resolves.toBe("legacy");
});

it("falls back at the deadline and ignores the still that arrives after it", async () => {
  const { media, clock, take, legacyCalls } = stills();
  let answer: string | undefined;
  void take().then((value) => (answer = value));
  await clock.advance(499);
  expect(answer).toBeUndefined();
  await clock.advance(1);
  expect(answer).toBe("legacy");
  media.message(
    { type: "still.done", request: "still-1", width: 2, height: 2, steps: [] },
    new Uint8Array(4),
  );
  await clock.advance(1);
  expect(answer).toBe("legacy");
  expect(legacyCalls()).toBe(1);
});

it("falls back at once when ace-media can't take the request", async () => {
  const { take, clock } = stills({ up: false });
  let answer: string | undefined;
  void take().then((value) => (answer = value));
  await clock.advance(0);
  expect(answer).toBe("legacy");
});

it("makes every waiting still the legacy way when ace-media goes away, and each only once", async () => {
  const { media, take, legacyCalls } = stills();
  const first = take();
  const second = take();
  media.lost();
  media.message({ type: "still.failed", request: "still-1", reason: "shutdown" }, new Uint8Array());
  await expect(Promise.all([first, second])).resolves.toEqual(["legacy", "legacy"]);
  expect(legacyCalls()).toBe(2);
  expect(media.pending).toBe(0);
});
