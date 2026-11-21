import { expect, test } from "vitest";
import { ImageProcess } from "./image-process.ts";
import { ImageError, type ImageJob } from "./images.ts";
import { FakeMedia, ManualClock, settle } from "./supervisor-test-support.ts";

/*
 * The image process as the daemon supervises it (ADR 0201 §3, §6), against a fake child: lazy
 * start with its own arguments, answers over its own lane, idle stop, restart after a crash,
 * unavailable after a crash loop, and the memory watchdog.
 */

function harness(options: { memory?: number[] } = {}) {
  const clock = new ManualClock();
  const children: { child: FakeMedia; args: readonly string[] }[] = [];
  const readings = [...(options.memory ?? [])];
  let ids = 0;
  const images = new ImageProcess({
    binary: "/opt/ace/media/ace-media",
    root: "/home/me/.ace",
    spawn: (_binary, args) => {
      const child = new FakeMedia(100 + children.length, {
        version: "x",
        ready: false,
        answerPings: false,
        answerRevocations: false,
        refuseLanes: true,
      });
      children.push({ child, args });
      return child;
    },
    clock,
    nextId: () => `i${++ids}`,
    random: () => 0.5,
    log: () => {},
    ...(options.memory
      ? { memory: { sample: async () => readings.shift(), limitBytes: 1000, intervalMs: 1000 } }
      : {}),
    idleMs: 60_000,
  });
  const last = () => children.at(-1)?.child;
  const jobs = () =>
    (last()?.stdin.messages("normal") ?? []).flatMap(({ message }) =>
      message.type === "image.job" ? [message.request] : [],
    );
  return { images, clock, children, last, jobs };
}

const probe = (deadlineMs = 5_000): ImageJob => ({
  inputs: [{ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) }],
  op: { op: "probe", maxPixels: 4096 },
  deadlineMs,
});

const answer = (child: FakeMedia | undefined, request: string) =>
  child?.send({
    type: "image.done",
    request,
    width: 2,
    height: 1,
    format: "none",
    source: { format: "png", width: 2, height: 1, orientation: 1 },
  });

async function reason(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof ImageError ? error.reason : error;
}

test("the image process starts on the first job with its own arguments, and answers there", async () => {
  const h = harness();
  expect(h.children).toEqual([]);
  const result = h.images.run(probe());
  await settle();
  expect(h.children.map((c) => c.args)).toEqual([["--images", "--root", "/home/me/.ace"]]);
  expect(h.jobs()).toEqual(["i1"]);
  answer(h.last(), "i1");
  await expect(result).resolves.toMatchObject({ width: 2, height: 1 });
});

test("an idle image process is stopped, and the next job starts a new one", async () => {
  const h = harness();
  const first = h.images.run(probe());
  await settle();
  answer(h.last(), "i1");
  await first;
  await h.clock.advance(59_999);
  expect(h.last()?.killed).toBe(false);
  await h.clock.advance(1);
  expect(h.last()?.killed).toBe(true);
  const second = h.images.run(probe());
  await settle();
  expect(h.children).toHaveLength(2);
  answer(h.last(), "i2");
  await expect(second).resolves.toMatchObject({ width: 2 });
});

test("a crash fails the job it held as exited, and the next job runs on a restarted process", async () => {
  const h = harness();
  const held = h.images.run(probe());
  await settle();
  h.last()?.exit(1, null);
  expect(await reason(held)).toBe("exited");
  const next = h.images.run(probe(10_000));
  await h.clock.advance(1_000);
  expect(h.children).toHaveLength(2);
  expect(h.jobs()).toEqual(["i2"]);
  answer(h.last(), "i2");
  await expect(next).resolves.toMatchObject({ width: 2 });
});

test("a crash loop makes images unavailable with the reason, and nothing is held", async () => {
  const h = harness();
  for (let n = 0; n < 5; n++) {
    const job = h.images.run(probe(60_000));
    // Past any backoff, so the job reaches a fresh process, which then fails.
    await h.clock.advance(20_000);
    expect(h.children).toHaveLength(n + 1);
    h.last()?.exit(101, null);
    expect(await reason(job)).toBe("exited");
  }
  const refused = await h.images.run(probe()).catch((e: unknown) => e);
  expect(refused instanceof ImageError && [refused.reason, refused.message]).toEqual([
    "unavailable",
    expect.stringContaining("exited 101"),
  ]);
  expect(h.images.pending).toBe(0);
});

test("an image process over its memory limit is killed and its job fails exited", async () => {
  const h = harness({ memory: [400, 900, 5000] });
  const held = h.images.run(probe(10_000));
  await h.clock.advance(2_000);
  expect(h.last()?.killed).toBe(false);
  await h.clock.advance(1_000);
  expect(h.last()?.killed).toBe(true);
  expect(await reason(held)).toBe("exited");
});

test("a disposed image process takes no more jobs", async () => {
  const h = harness();
  h.images.dispose();
  expect(await reason(h.images.run(probe()))).toBe("cancelled");
  expect(h.children).toEqual([]);
});
