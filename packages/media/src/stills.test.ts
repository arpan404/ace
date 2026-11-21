import { expect, it } from "vitest";
import { MediaStills, type StillRequest } from "./stills.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import type { ToMedia } from "./wire.ts";

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

function stills(
  options: { health?: MediaHealth; up?: boolean; features?: string[]; minEpoch?: number } = {},
) {
  const clock = new ManualClock();
  const sent: ToMedia[] = [];
  let next = 0;
  let sourceCalls = 0;
  const media = new MediaStills({
    health: () => options.health ?? "healthy",
    send: (message) => {
      if (options.up === false) return false;
      sent.push(message);
      return true;
    },
    clock,
    nextId: () => `still-${++next}`,
    speaks: (feature) => (options.features ?? []).includes(feature),
  });
  const take = () =>
    media.take(
      options.minEpoch === undefined ? request : { ...request, minEpoch: options.minEpoch },
      async () => {
        sourceCalls++;
        return "source";
      },
      (still) =>
        `ace-media ${still.width}x${still.height} ${still.jpeg.length}B ${still.steps.length} steps`,
    );
  return { media, clock, sent, take, sourceCalls: () => sourceCalls };
}

it("takes the still from the source's own capture while ace-media isn't healthy, sending nothing", async () => {
  for (const health of ["restarting", "unavailable"] as const) {
    const { take, sent, sourceCalls } = stills({ health });
    await expect(take()).resolves.toBe("source");
    expect(sent).toEqual([]);
    expect(sourceCalls()).toBe(1);
  }
});

it("answers with ace-media's JPEG and its path when still.done arrives in time", async () => {
  const { media, take, sent, sourceCalls } = stills();
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
  expect(sourceCalls()).toBe(0);
  expect(media.pending).toBe(0);
});

it("falls back to the source's own capture when ace-media fails the still", async () => {
  const { media, take } = stills();
  const still = take();
  media.message(
    { type: "still.failed", request: "still-1", reason: "decode-unavailable" },
    new Uint8Array(),
  );
  await expect(still).resolves.toBe("source");
});

it("falls back at the deadline and ignores the still that arrives after it", async () => {
  const { media, clock, take, sourceCalls } = stills();
  let answer: string | undefined;
  void take().then((value) => (answer = value));
  await clock.advance(499);
  expect(answer).toBeUndefined();
  await clock.advance(1);
  expect(answer).toBe("source");
  media.message(
    { type: "still.done", request: "still-1", width: 2, height: 2, steps: [] },
    new Uint8Array(4),
  );
  await clock.advance(1);
  expect(answer).toBe("source");
  expect(sourceCalls()).toBe(1);
});

it("falls back at once when ace-media can't take the request", async () => {
  const { take, clock } = stills({ up: false });
  let answer: string | undefined;
  void take().then((value) => (answer = value));
  await clock.advance(0);
  expect(answer).toBe("source");
});

it("takes every waiting still from its source when ace-media goes away, and each only once", async () => {
  const { media, take, sourceCalls } = stills();
  const first = take();
  const second = take();
  media.lost();
  media.message({ type: "still.failed", request: "still-1", reason: "shutdown" }, new Uint8Array());
  await expect(Promise.all([first, second])).resolves.toEqual(["source", "source"]);
  expect(sourceCalls()).toBe(2);
  expect(media.pending).toBe(0);
});

it("a still fenced on the newest public epoch carries it to an ace-media that honours it, and never to one that doesn't", async () => {
  const fenced = stills({ features: ["picture-ingest", "privacy-open"], minEpoch: 4 });
  void fenced.take();
  expect(fenced.sent).toEqual([
    { type: "still.take", request: "still-1", ...request, minEpoch: 4 },
  ]);
  // A build without privacy-open (even one with picture-ingest) would refuse the field: the
  // source's own capture answers instead.
  const older = stills({ features: ["picture-ingest"], minEpoch: 4 });
  await expect(older.take()).resolves.toBe("source");
  expect(older.sent).toEqual([]);
});
