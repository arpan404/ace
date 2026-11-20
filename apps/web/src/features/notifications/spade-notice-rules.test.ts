import { describe, expect, it } from "vitest";
import { Notification } from "@ace/protocol";
import { openSpadeAgent, spadeShow, withinBurst } from "./spade-notice-rules.ts";

const alert = Notification.parse({
  id: "spade:event:c1:7",
  threadId: "spade-host",
  title: "Booker",
  status: "spade",
  message: "Asks: Window or aisle?",
  backgroundCount: 0,
  actions: [],
  spade: { agent: "a1", conversation: "c1", request: "q2", category: "needs_you" },
});
const seen = { on: true, visible: true, openAgent: undefined, recent: [1] };

describe("how a Spade alert shows in a window", () => {
  it("nothing shows for the conversation the person is looking at", () => {
    expect(spadeShow(alert, { ...seen, openAgent: "a1" })).toEqual({ kind: "skip", why: "open" });
    // Behind another window, the same conversation is not being looked at.
    expect(spadeShow(alert, { ...seen, openAgent: "a1", visible: false }).kind).toBe("system");
  });

  it("a toast in front, a system notification behind, each opening its request", () => {
    expect(spadeShow(alert, { ...seen, openAgent: "a2" })).toEqual({
      kind: "toast",
      title: "Booker",
      body: "Asks: Window or aisle?",
      tag: "spade:a1",
      agent: "a1",
      request: "q2",
    });
    expect(spadeShow(alert, { ...seen, visible: false }).kind).toBe("system");
    expect(spadeShow(alert, { ...seen, on: false })).toEqual({ kind: "skip", why: "off" });
  });

  it("a burst shows as one line", () => {
    const recent = [0, 1_000, 2_000, 3_000].reduce<number[]>((at, now) => withinBurst(at, now), []);
    expect(spadeShow(alert, { ...seen, recent })).toMatchObject({
      kind: "burst",
      body: "4 updates from your bots",
    });
    expect(withinBurst(recent, 20_000)).toEqual([20_000]);
  });

  it("knows which bot's conversation a page shows", () => {
    expect(openSpadeAgent("/spade/a1", {})).toBe("a1");
    expect(openSpadeAgent("/spade/a1", { on: "laptop" })).toBeUndefined();
    expect(openSpadeAgent("/spade/new", {})).toBeUndefined();
    expect(openSpadeAgent("/t/thread-1", {})).toBeUndefined();
  });
});
