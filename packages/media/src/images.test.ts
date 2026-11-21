import { expect, test } from "vitest";
import type { MediaPhase } from "./diagnostics.ts";
import {
  ImageError,
  MediaImages,
  maxHeldImageBytes,
  maxImagePayload,
  type ImageJob,
} from "./images.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/** ace-media as the images client sees it: lanes up or not, a phase, uses held, and time. */
function harness(start: { up: boolean; phase?: MediaPhase; reason?: string } = { up: true }) {
  const state = {
    up: start.up,
    phase: start.phase ?? ("running" as MediaPhase),
    reason: start.reason,
  };
  const sent: ToMedia[] = [];
  let uses = 0;
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  let ids = 0;
  const images = new MediaImages({
    send: (message, _payload, written) => {
      if (!state.up) return false;
      sent.push(message);
      written?.();
      return true;
    },
    withdraw: () => "written",
    require: () => {
      uses++;
      let released = false;
      return () => {
        if (!released) uses--;
        released = true;
      };
    },
    phase: () => ({ phase: state.phase, reason: state.reason }),
    clock: {
      now: () => now,
      setTimeout: (run, ms) => {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    },
    nextId: () => `i${++ids}`,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of Array.from(timers))
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }
  };
  const answer = (message: FromMedia, payload = new Uint8Array(0)) =>
    images.message(message, payload);
  return { images, state, sent, uses: () => uses, advance, answer };
}

const probe = (deadlineMs = 1000, signal?: AbortSignal): ImageJob => ({
  inputs: [{ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }],
  op: { op: "probe", maxPixels: 4096 },
  deadlineMs,
  signal,
});

const done = (request: string): FromMedia => ({
  type: "image.done",
  request,
  width: 4,
  height: 2,
  format: "png",
  source: { format: "png", width: 8, height: 4, orientation: 1 },
});

async function failure(promise: Promise<unknown>): Promise<ImageError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ImageError))
    throw new Error(`expected an ImageError, got ${String(error)}`);
  return error;
}

test("a job waits for ace-media's lanes, is sent once, and settles with its image", async () => {
  const h = harness({ up: false, phase: "starting" });
  const result = h.images.run(probe());
  expect(h.sent).toEqual([]);
  expect(h.uses()).toBe(1);
  h.state.up = true;
  h.images.ready();
  h.images.ready();
  expect(h.sent).toEqual([
    {
      type: "image.job",
      request: "i1",
      deadlineMs: 1000,
      inputs: [{ kind: "bytes", bytes: 3 }],
      op: { op: "probe", maxPixels: 4096 },
    },
  ]);
  const png = new Uint8Array([9, 9]);
  h.answer(done("i1"), png);
  png.fill(0);
  await expect(result).resolves.toMatchObject({
    width: 4,
    height: 2,
    bytes: new Uint8Array([9, 9]),
  });
  expect(h.uses()).toBe(0);
  expect(h.images.pending).toBe(0);
});

test("with ace-media unavailable a job fails at once with the reason and holds nothing", async () => {
  const h = harness({ up: false, phase: "unavailable", reason: "crash loop" });
  const error = await failure(h.images.run(probe()));
  expect(error.reason).toBe("unavailable");
  expect(error.message).toContain("crash loop");
  expect(error.passing).toBe(true);
  expect(h.images.pending).toBe(0);
  expect(h.uses()).toBe(0);
});

test("a refusal from ace-media reaches the caller with its reason and sentence", async () => {
  const h = harness();
  const result = h.images.run(probe());
  h.answer({
    type: "image.failed",
    request: "i1",
    reason: "truncated",
    message: "The JPEG ends early: the image is incomplete.",
  });
  const error = await failure(result);
  expect(error.reason).toBe("truncated");
  expect(error.message).toBe("The JPEG ends early: the image is incomplete.");
  expect(error.passing).toBe(false);
});

test("a job past its deadline fails, ace-media is told to cancel it, and its late answer is dropped", async () => {
  const h = harness();
  const result = h.images.run(probe(500));
  h.advance(499);
  expect(h.images.pending).toBe(1);
  h.advance(1);
  expect((await failure(result)).reason).toBe("deadline");
  expect(h.sent.at(-1)).toEqual({ type: "image.cancel", request: "i1" });
  h.answer(done("i1"));
  expect(h.images.pending).toBe(0);
  expect(h.uses()).toBe(0);
});

test("a job that never reached ace-media fails at its deadline without a cancel", async () => {
  const h = harness({ up: false, phase: "starting" });
  const result = h.images.run(probe(300));
  h.advance(300);
  expect((await failure(result)).reason).toBe("deadline");
  expect(h.sent).toEqual([]);
});

test("aborting the caller's signal cancels the job", async () => {
  const h = harness();
  const controller = new AbortController();
  const result = h.images.run(probe(1000, controller.signal));
  controller.abort();
  expect((await failure(result)).reason).toBe("cancelled");
  expect(h.sent.at(-1)).toEqual({ type: "image.cancel", request: "i1" });
  expect((await failure(h.images.run(probe(1000, controller.signal)))).reason).toBe("cancelled");
});

test("ace-media exiting fails the jobs it held but keeps those waiting for the restart", async () => {
  const h = harness();
  const held = h.images.run(probe());
  h.state.up = false;
  h.state.phase = "backoff";
  const waiting = h.images.run(probe());
  h.images.exited();
  expect((await failure(held)).reason).toBe("exited");
  h.state.up = true;
  h.state.phase = "running";
  h.images.ready();
  expect(
    h.sent.filter((m) => m.type === "image.job").map((m) => m.type === "image.job" && m.request),
  ).toEqual(["i1", "i2"]);
  h.answer(done("i2"));
  await expect(waiting).resolves.toMatchObject({ width: 4 });
});

test("ace-media turning unavailable fails every waiting job with the reason", async () => {
  const h = harness({ up: false, phase: "starting" });
  const waiting = h.images.run(probe());
  h.state.phase = "unavailable";
  h.state.reason = "protocol or version mismatch (exit 2)";
  h.images.exited();
  const error = await failure(waiting);
  expect(error.reason).toBe("unavailable");
  expect(error.message).toContain("version mismatch");
  expect(h.uses()).toBe(0);
});

test("inputs too large for one frame are refused before anything is sent", async () => {
  const h = harness();
  const job: ImageJob = {
    inputs: [{ kind: "bytes", bytes: new Uint8Array(maxImagePayload + 1) }],
    op: { op: "probe", maxPixels: 1 },
    deadlineMs: 100,
  };
  expect((await failure(h.images.run(job))).reason).toBe("too-large");
  expect(h.sent).toEqual([]);
  expect(h.uses()).toBe(0);
});

test("only a bounded number of jobs may wait for ace-media", async () => {
  const h = harness({ up: false, phase: "starting" });
  const waiting = Array.from({ length: 32 }, () => h.images.run(probe()));
  expect((await failure(h.images.run(probe()))).reason).toBe("busy");
  h.advance(1000);
  for (const job of waiting) expect((await failure(job)).reason).toBe("deadline");
});

/** A job carrying the most payload one job may. */
const big = (deadlineMs: number): ImageJob => ({
  inputs: [{ kind: "bytes", bytes: new Uint8Array(maxImagePayload) }],
  op: { op: "probe", maxPixels: 4096 },
  deadlineMs,
});

test("image bytes held past the bound are refused busy, and room comes back as jobs settle", async () => {
  const h = harness({ up: false, phase: "starting" });
  const held = Math.floor(maxHeldImageBytes / maxImagePayload);
  const first = h.images.run(big(100));
  const rest = Array.from({ length: held - 1 }, () => h.images.run(big(1000)));
  expect((await failure(h.images.run(big(1000)))).reason).toBe("busy");
  // The first one's deadline frees its bytes: the same job is taken now.
  h.advance(100);
  expect((await failure(first)).reason).toBe("deadline");
  const again = h.images.run(big(1000));
  h.advance(1000);
  for (const job of [...rest, again]) expect((await failure(job)).reason).toBe("deadline");
});

/** ace-media up, with a lane whose writes the test finishes: frames wait, are written, or both. */
function heldLane() {
  type Frame = { message: ToMedia; state: "queued" | "writing" | "written"; written: () => void };
  const frames: Frame[] = [];
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  let ids = 0;
  const images = new MediaImages({
    send: (message, _payload, written) => {
      frames.push({ message, state: "queued", written: written ?? (() => {}) });
      return true;
    },
    withdraw: (request) => {
      const frame = frames.find(
        (f) => f.message.type === "image.job" && f.message.request === request,
      );
      if (!frame) return "written";
      if (frame.state === "queued") {
        frames.splice(frames.indexOf(frame), 1);
        return "dropped";
      }
      return frame.state === "writing" ? "pending" : "written";
    },
    require: () => () => {},
    phase: () => ({ phase: "running" }),
    clock: {
      now: () => now,
      setTimeout: (run, ms) => {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    },
    nextId: () => `i${++ids}`,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of Array.from(timers))
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }
  };
  /** The lane starts writing its next frame. */
  const start = () => {
    const frame = frames.find((f) => f.state === "queued");
    if (frame) frame.state = "writing";
  };
  /** The frame being written is done. */
  const finish = () => {
    const frame = frames.find((f) => f.state === "writing");
    if (!frame) return;
    frame.state = "written";
    frame.written();
  };
  const types = () => frames.map((f) => f.message.type);
  return { images, frames, advance, start, finish, types };
}

test("a job settled before its frame is written is taken off the lane, its bytes freed and no cancel sent", async () => {
  const h = heldLane();
  const first = h.images.run(big(100));
  h.advance(100);
  expect((await failure(first)).reason).toBe("deadline");
  expect(h.types()).toEqual([]);
  // Its bytes are free: the cap takes as many big jobs as before.
  const held = Math.floor(maxHeldImageBytes / maxImagePayload);
  const rest = Array.from({ length: held }, () => h.images.run(big(1000)));
  expect(h.types()).toHaveLength(held);
  h.advance(1000);
  for (const job of rest) await failure(job);
});

test("a frame partly written when its job settles stays charged until written, then is cancelled", async () => {
  const h = heldLane();
  const first = h.images.run(big(100));
  h.start();
  h.advance(100);
  expect((await failure(first)).reason).toBe("deadline");
  // Still on its way to ace-media: its bytes still count, and no cancel can overtake it.
  const held = Math.floor(maxHeldImageBytes / maxImagePayload);
  const others = Array.from({ length: held - 1 }, () => h.images.run(big(5000)));
  expect((await failure(h.images.run(big(5000)))).reason).toBe("busy");
  expect(h.types().filter((t) => t === "image.cancel")).toEqual([]);
  h.finish();
  expect(h.types().at(-1)).toBe("image.cancel");
  const now = h.images.run(big(5000));
  h.advance(5000);
  for (const job of [...others, now]) expect((await failure(job)).reason).toBe("deadline");
});

test("a job that waited for ace-media carries only its remaining time, never a fresh deadline", async () => {
  const h = harness({ up: false, phase: "starting" });
  const result = h.images.run(probe(1000));
  h.advance(400);
  h.state.up = true;
  h.images.ready();
  expect(h.sent).toMatchObject([{ type: "image.job", deadlineMs: 600 }]);
  h.advance(600);
  expect((await failure(result)).reason).toBe("deadline");
});
