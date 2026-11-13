import { describe, expect, it } from "vitest";
import {
  PersonPresence,
  personQuietMs,
  personWaitMs,
  presenceStep,
  waitedNote,
  type PresenceClock,
} from "./presence.ts";

/** A clock that only moves when the test says so, running timers that come due on the way. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let timers: { at: number; run: () => void }[] = [];
  const clock: PresenceClock = {
    now: () => now,
    set(ms, run) {
      const timer = { at: now + Math.max(0, ms), run };
      timers.push(timer);
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await Promise.resolve();
      await Promise.resolve();
      const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = end;
    await Promise.resolve();
  };
  return { clock, advance };
}

describe("presenceStep", () => {
  const since = 0;
  it.each([
    ["the person never acted", 10_000, -Infinity, "run"],
    ["the lease lapsed", 10_000, 10_000 - personQuietMs, "run"],
    ["the person typed a second ago", 10_000, 9_000, "wait 2000"],
    ["the wait runs out before the lease", personWaitMs - 1_000, personWaitMs - 1_500, "wait 1000"],
    ["a minute of waiting passed", personWaitMs, personWaitMs - 100, "give_up"],
  ])("%s", (_name, now, personAt, expected) => {
    const step = presenceStep(now, personAt, since);
    expect(step.kind === "wait" ? `wait ${step.ms}` : step.kind).toBe(expected);
  });
});

describe("waitedNote", () => {
  it.each([
    [100, undefined],
    [4_200, "Waited 4 s while the person used this tab."],
  ])("after %i ms", (ms, note) => {
    expect(waitedNote(ms, "this tab")).toBe(note);
  });
});

describe("PersonPresence", () => {
  it("an agent action waits while the person types and runs once the lease lapses", async () => {
    const { clock, advance } = fakeClock();
    const presence = new PersonPresence({ clock });
    presence.input("tab:a");
    let result: unknown;
    void presence.yield("tab:a").then((value) => (result = value));
    await advance(1_000);
    presence.input("tab:a");
    await advance(2_500);
    expect(result).toBeUndefined();
    await advance(600);
    expect(result).toEqual({ busy: false, waitedMs: 1_000 + personQuietMs });
  });

  it("another surface does not wait", async () => {
    const { clock } = fakeClock();
    const presence = new PersonPresence({ clock });
    presence.input("tab:a");
    await expect(presence.yield("tab:b")).resolves.toEqual({ busy: false, waitedMs: 0 });
  });

  it("gives up after a minute of the person's input", async () => {
    const { clock, advance } = fakeClock();
    const presence = new PersonPresence({ clock });
    presence.input("app:com.apple.Safari");
    let result: unknown;
    void presence.yield("app:com.apple.Safari").then((value) => (result = value));
    for (let second = 0; second < 61; second++) {
      presence.input("app:com.apple.Safari");
      await advance(1_000);
    }
    expect(result).toEqual({ busy: true, waitedMs: personWaitMs });
  });

  it("physical input on a frontmost app holds the lease without routed input", async () => {
    const { clock, advance } = fakeClock();
    let typingUntil = clock.now() + 5_000;
    const presence = new PersonPresence({
      clock,
      // The idle source: the person's last keystroke, while they keep typing.
      sample: async () => Math.min(clock.now(), typingUntil),
    });
    let result: { busy: boolean; waitedMs: number } | undefined;
    void presence.yield("app:com.apple.TextEdit").then((value) => (result = value));
    await advance(4_000);
    expect(result).toBeUndefined();
    typingUntil = clock.now();
    await advance(personQuietMs + 1_000);
    expect(result?.busy).toBe(false);
    expect(result?.waitedMs).toBeGreaterThanOrEqual(4_000 + personQuietMs - 1);
  });

  it("tells when a surface becomes active and when it lapses", async () => {
    const { clock, advance } = fakeClock();
    const changes: string[] = [];
    const presence = new PersonPresence({
      clock,
      changed: (surface, active) => changes.push(`${surface} ${active}`),
    });
    presence.input("device:1");
    presence.input("device:1");
    await advance(personQuietMs);
    expect(changes).toEqual(["device:1 true", "device:1 false"]);
    expect(presence.active("device:1")).toBe(false);
  });

  it("an aborted wait ends at once", async () => {
    const { clock } = fakeClock();
    const presence = new PersonPresence({ clock });
    presence.input("tab:a");
    const controller = new AbortController();
    const waiting = presence.yield("tab:a", controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
});

it("lease expiry keeps streams active while physical input continues", async () => {
  const { clock, advance } = fakeClock();
  let typing = true;
  const changes: boolean[] = [];
  const presence = new PersonPresence({
    clock,
    sample: async () => (typing ? clock.now() : undefined),
    changed: (_surface, active) => changes.push(active),
  });
  presence.input("app:editor");
  await advance(personQuietMs);
  expect(presence.active("app:editor")).toBe(true);
  expect(changes).not.toContain(false);
  typing = false;
  await advance(personQuietMs);
  expect(presence.active("app:editor")).toBe(false);
  expect(changes.at(-1)).toBe(false);
});
