import { expect, it } from "vitest";
import type { IngestAddress, IngestProducer } from "./ingest-sources.ts";
import { restartingReason } from "./ingest-sources.ts";
import { sourceKinds } from "./routes.ts";
import { MediaRuntime } from "./runtime.ts";
import { harness } from "./supervisor-test-support.ts";

/*
 * X2's acceptance (docs/media/plan.md, Wave 7): ace-media is the only path a producer has, so
 * while it can't take a source the producer is told why. (Recovery after a kill is measured
 * through the real producer adapters: `media-recovery.test.ts` in the browser and screen.) The supervisor, routes and sources are the real
 * ones; only the ace-media process is faked, at its lanes, with the injected clock and jitter.
 */

function world(random: number) {
  const h = harness({ random: () => random });
  const {
    replay: _replay,
    onMessage: _message,
    onEgress: _egress,
    onExit: _exit,
    ...options
  } = h.options;
  let ids = 0;
  const runtime = new MediaRuntime({
    ...options,
    id: () => `s${++ids}`,
    capabilities: { ingest: sourceKinds, recordings: false, stills: false, delivery: false },
  });
  const points: { at: number; address: IngestAddress | undefined }[] = [];
  const stops: string[] = [];
  const producer: IngestProducer = {
    source: "tab-1",
    kind: "tab",
    origin: { kind: "tab" },
    epoch: () => 0,
    consumers: { deliver: () => {}, record: () => {}, still: () => {} },
    point: (address) => {
      points.push({ at: h.clock.now(), address });
      return Promise.resolve();
    },
    keyframe: () => {},
    stopped: (reason) => void stops.push(reason),
  };
  /** ace-media's side: every open it is sent is answered `starting`, once. */
  const answered = new Set<string>();
  const answer = () => {
    const child = h.host.children.at(-1);
    if (!child || child.gone) return;
    for (const { message } of child.stdin.messages("normal"))
      if (message.type === "source.open" && !answered.has(message.source)) {
        answered.add(message.source);
        child.send({ type: "source.status", source: message.source, status: "starting" });
      }
  };
  /** Moves the clock in small steps, as ace-media would answer, until `done` or `ms`. */
  const run = async (ms: number, done: () => boolean) => {
    for (let waited = 0; waited <= ms && !done(); waited += 10) {
      answer();
      await h.clock.advance(10);
    }
  };
  return { h, runtime, producer, points, stops, run };
}

it("an ace-media that keeps crashing becomes unavailable, and a producer added then is told so at once", async () => {
  const w = world(0.5);
  w.h.host.behaviour.exitAtOnce = 1;
  const source = w.runtime.sources.add(w.producer);
  await w.run(60_000, () => w.runtime.supervisor.snapshot().phase === "unavailable");
  expect(w.runtime.supervisor.snapshot().phase).toBe("unavailable");
  const late: string[] = [];
  const other = w.runtime.sources.add({
    ...w.producer,
    source: "tab-2",
    stopped: (reason) => void late.push(reason),
  });
  expect(late).toHaveLength(1);
  expect(late[0]).toMatch(/^ace-media is unavailable/);
  expect(w.points.every((p) => p.address === undefined)).toBe(true);
  other.close();
  source.close();
  w.runtime.dispose();
});

it("a tab attached before ace-media's first launch, which dies before it is ready, is told it is restarting and then unavailable", async () => {
  const w = world(0.5);
  w.h.host.behaviour.exitAtOnce = 1;
  const source = w.runtime.sources.add(w.producer);
  expect(w.stops).toEqual([]);
  await w.run(1_000, () => w.stops.length > 0);
  expect(w.stops[0]).toBe(restartingReason);
  await w.run(60_000, () => w.runtime.supervisor.snapshot().phase === "unavailable");
  await w.run(100, () => false);
  expect(w.stops.at(-1)).toMatch(/^ace-media is unavailable/);
  expect(w.points.every((p) => p.address === undefined)).toBe(true);
  source.close();
  w.runtime.dispose();
});
