import { AgentId, Event, Interaction, ItemId, type ServerMessage } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { linkEstimate } from "./link-estimate.ts";
import type { MainSocket } from "./main-socket.ts";
import { Outbox, defaultPressure } from "./outbox.ts";

/** A socket whose backlog the test sets: how fast the link drains is what it can't control. */
function socket(backlog: number) {
  const frames: string[] = [];
  const fake = {
    readyState: 1 as const,
    bufferedAmount: backlog,
    isPaused: false,
    send(data: unknown, ...rest: unknown[]) {
      frames.push(String(data));
      const done = rest.find((value) => typeof value === "function") as (() => void) | undefined;
      done?.();
    },
    close() {},
    terminate() {},
    pause() {},
    resume() {},
    on() {},
    once() {},
    off() {},
  };
  return { fake: fake as unknown as MainSocket, frames, raw: fake };
}

function clock() {
  const holds: { ms: number; fire(): void; live: boolean }[] = [];
  return {
    holds,
    delay(callback: () => void, ms: number) {
      const hold = { ms, live: true, fire: callback };
      holds.push(hold);
      return () => {
        hold.live = false;
      };
    },
  };
}

let seq = 0;
const events = (payload: Event["payload"]): ServerMessage => {
  seq++;
  return {
    type: "events",
    subscriptionId: "s",
    afterSeq: seq - 1,
    throughSeq: seq,
    events: [Event.parse({ seq, id: `e${seq}`, at: 0, threadId: "t", payload })],
  };
};
const delta = (append: string) =>
  events({
    type: "item.delta",
    itemId: ItemId.parse("i"),
    agentId: AgentId.parse("a"),
    field: "text",
    append,
  });

function linked(backlog: number, remote: boolean) {
  const link = socket(backlog);
  const timers = clock();
  const outbox = new Outbox(link.fake, defaultPressure, () => 0, undefined, timers.delay);
  outbox.packFrames(remote);
  return { ...link, timers, outbox };
}

describe("holding deltas by link", () => {
  it("a remote link with a backlog holds deltas longer, so more share one frame", () => {
    const slow = linked(100 * 1024, true);
    for (const text of ["a", "b", "c"]) slow.outbox.send(delta(text));
    expect(slow.timers.holds.map((hold) => hold.ms)).toEqual([250]);
    expect(slow.frames).toEqual([]);
    slow.timers.holds[0]?.fire();
    expect(slow.frames).toHaveLength(1);
    expect(slow.frames[0]?.split("\n")).toHaveLength(3);
  });

  it("a remote link that keeps up, and loopback even with a backlog, hold 16 ms", () => {
    const fast = linked(0, true);
    fast.outbox.send(delta("a"));
    const local = linked(100 * 1024, false);
    local.outbox.send(delta("a"));
    expect([...fast.timers.holds, ...local.timers.holds].map((hold) => hold.ms)).toEqual([16, 16]);
  });

  it("an approval never waits behind held deltas: it goes at once, after them", () => {
    const slow = linked(100 * 1024, true);
    slow.outbox.send(delta("thinking"));
    slow.outbox.send(
      events({
        type: "interaction.opened",
        interaction: Interaction.parse({
          id: "ask",
          threadId: "t",
          agentId: AgentId.parse("a"),
          blocking: true,
          state: "pending",
          createdAt: 0,
          request: { kind: "approval", title: "Run rm -rf build", options: [] },
        }),
      }),
    );
    expect(slow.frames).toHaveLength(1);
    const lines = slow.frames[0]?.split("\n") ?? [];
    expect(lines.map((line) => JSON.parse(line).events[0].payload.type)).toEqual([
      "item.delta",
      "interaction.opened",
    ]);
  });

  it("the socket's link estimate is readable by anyone, and never claims a round trip", () => {
    const slow = linked(30 * 1024, true);
    slow.outbox.send(delta("a"));
    slow.timers.holds[0]?.fire();
    expect(linkEstimate(slow.fake)).toMatchObject({
      remote: true,
      backlogBytes: 30 * 1024,
      roundTripMs: undefined,
    });
    expect(linkEstimate(slow.fake)?.smoothedBacklogBytes).toBeGreaterThan(0);
  });
});
