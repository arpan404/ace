import { describe, expect, it } from "vitest";
import { PathMerge } from "./path-merge.ts";

type Unit = { stream: string; key: boolean; mark: string };

const unit = (mark: string, key = false, stream = "a"): Unit => ({ stream, key, mark });

function merge(holdMs = 1_000) {
  const emitted: string[] = [];
  const timers: { run: () => void; cancelled: boolean; ms: number }[] = [];
  const m = new PathMerge<Unit>("daemon", {
    emit: (u) => void emitted.push(u.mark),
    stream: (u) => u.stream,
    key: (u) => u.key,
    schedule: (run, ms) => {
      const timer = { run, cancelled: false, ms };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    holdMs,
  });
  const fire = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  };
  return { m, emitted, fire, timers };
}

describe("PathMerge", () => {
  it("holds the new path's keyframe until the old path's late deltas and its end have arrived", () => {
    const { m, emitted } = merge();
    m.switching("media:1");
    m.deliver("media:1", unit("m-key", true));
    m.deliver("media:1", unit("m-1"));
    m.ended("daemon", false);
    m.deliver("media:1", unit("m-2"));
    expect(emitted).toEqual(["m-key", "m-1", "m-2"]);

    // Back to the daemon: its fresh keyframe overtakes ace-media's last deltas on the wire.
    m.switching("daemon");
    m.deliver("daemon", unit("d-key", true));
    m.deliver("media:1", unit("m-3"));
    m.deliver("media:1", unit("m-4"));
    expect(emitted.slice(3)).toEqual(["m-3", "m-4"]);
    m.ended("media:1", false);
    m.deliver("daemon", unit("d-1"));
    expect(emitted.slice(3)).toEqual(["m-3", "m-4", "d-key", "d-1"]);
  });

  it("an interrupted end drops the new path's deltas until each stream's keyframe", () => {
    const { m, emitted } = merge();
    m.switching("media:2");
    m.deliver("media:2", unit("a-delta"));
    m.deliver("media:2", unit("b-key", true, "b"));
    m.deliver("media:2", unit("a-key", true));
    m.ended("daemon", true);
    m.deliver("media:2", unit("a-1"));
    expect(emitted).toEqual(["b-key", "a-key", "a-1"]);
  });

  it("a switch whose old path never ends times out: the new path starts at its keyframe and the old path's stragglers are dropped", () => {
    const { m, emitted, fire, timers } = merge(800);
    m.switching("media:3");
    expect(timers[0]?.ms).toBe(800);
    m.deliver("media:3", unit("m-delta"));
    m.deliver("media:3", unit("m-key", true));
    fire();
    m.deliver("daemon", unit("d-late"));
    m.deliver("media:3", unit("m-1"));
    expect(emitted).toEqual(["m-key", "m-1"]);
    expect(m.stale).toBe(2);
  });

  it("a later end of a path already given up on changes nothing", () => {
    const { m, emitted, fire } = merge();
    m.switching("media:4");
    m.deliver("media:4", unit("k", true));
    fire();
    m.ended("daemon", false);
    m.deliver("media:4", unit("1"));
    expect(emitted).toEqual(["k", "1"]);
  });

  it("units of a path that is neither current nor coming are dropped", () => {
    const { m, emitted } = merge();
    m.deliver("media:9", unit("x", true));
    m.deliver("daemon", unit("d", true));
    expect(emitted).toEqual(["d"]);
    expect(m.stale).toBe(1);
  });

  it("a second switch before the first settles cuts the first short", () => {
    const { m, emitted } = merge();
    m.switching("media:5");
    m.deliver("media:5", unit("m-delta"));
    m.switching("daemon");
    m.deliver("daemon", unit("d-key", true));
    m.ended("media:5", false);
    expect(emitted).toEqual(["d-key"]);
  });

  it("hearing the same switch twice (the daemon's and the producer's word) is one switch", () => {
    const { m, emitted } = merge();
    m.switching("media:6");
    m.ended("daemon", false);
    m.switching("daemon");
    m.deliver("daemon", unit("d-key", true));
    m.switching("daemon");
    m.deliver("media:6", unit("m-late"));
    m.ended("media:6", false);
    expect(emitted).toEqual(["m-late", "d-key"]);
  });

  it("a switch abandoned before the old path ended keeps the old path, losing none of its units", () => {
    const { m, emitted } = merge();
    m.deliver("daemon", unit("d-1", true));
    m.switching("media:7");
    m.deliver("daemon", unit("d-2"));
    // The producer's socket never opened: it says it is still on the daemon's path.
    m.switching("daemon");
    m.deliver("daemon", unit("d-3"));
    m.deliver("media:7", unit("m-x"));
    expect(emitted).toEqual(["d-1", "d-2", "d-3"]);
  });
});
