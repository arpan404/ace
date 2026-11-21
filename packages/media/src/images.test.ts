import { expect, test } from "vitest";
import type { MediaPhase } from "./diagnostics.ts";
import { ImageError, MediaImages, maxImagePayload, type ImageJob } from "./images.ts";
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
    send: (message) => {
      if (!state.up) return false;
      sent.push(message);
      return true;
    },
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
