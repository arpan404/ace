import { describe, expect, it } from "vitest";
import { signGrant } from "@ace/account-grant";
import type { ClientMessage } from "@ace/protocol";
import { GRANT_RETRY_MS, grantRefreshDelay, keepGrant } from "./grant-keeper.ts";

describe("when a socket's grant is refreshed", () => {
  it.each([
    { ttlMs: 300_000, delay: 240_000 },
    { ttlMs: 120_001, delay: 60_001 },
    { ttlMs: 120_000, delay: 60_000 },
    { ttlMs: 30_000, delay: 15_000 },
    { ttlMs: 1, delay: 0 },
    { ttlMs: 0, delay: 0 },
    { ttlMs: -5, delay: 0 },
  ])("with $ttlMs ms left: after $delay ms", ({ ttlMs, delay }) => {
    expect(grantRefreshDelay(ttlMs)).toBe(delay);
  });
});

/** A scheduler whose timers run only when the test says. */
function manualScheduler() {
  const timers: { delayMs: number; run(): void; cancelled: boolean }[] = [];
  return {
    timers,
    set(delayMs: number, run: () => void) {
      const timer = { delayMs, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Run the newest live timer and let its promise chain settle. */
    async fire() {
      const timer = timers.findLast((candidate) => !candidate.cancelled);
      if (!timer) throw new Error("No timer");
      timer.cancelled = true;
      timer.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return timer.delayMs;
    },
    live: () => timers.filter((timer) => !timer.cancelled),
  };
}

const ignore = () => {};
const key = { id: "k1", privateKey: new Uint8Array(32).fill(7) };
const grant = (lifetimeMs: number) =>
  signGrant({ kind: "device", account: "a", subject: "phone", iat: 0, exp: lifetimeMs }, key);

describe("keeping a socket's grant fresh", () => {
  it("sends a new grant before the welcome's runs out, then times the next from the new one", async () => {
    const scheduler = manualScheduler();
    const sent: ClientMessage[] = [];
    let ids = 0;
    keepGrant({
      ttlMs: 200_000,
      grant: async () => grant(300_000),
      send: (message) => sent.push(message),
      scheduler,
      id: () => `r${++ids}`,
    });
    expect(sent).toEqual([]);
    expect(await scheduler.fire()).toBe(140_000);
    expect(sent).toEqual([
      { type: "account.grant.refresh", requestId: "r1", grant: grant(300_000) },
    ]);
    expect(await scheduler.fire()).toBe(240_000);
    expect(sent).toHaveLength(2);
  });

  it("tries again shortly when a grant can't be fetched", async () => {
    const scheduler = manualScheduler();
    const sent: ClientMessage[] = [];
    let fetches = 0;
    keepGrant({
      ttlMs: 300_000,
      grant: async () => {
        if (++fetches === 1) throw new Error("offline");
        return grant(300_000);
      },
      send: (message) => sent.push(message),
      scheduler,
      id: () => "r",
    });
    await scheduler.fire();
    expect(sent).toEqual([]);
    expect(await scheduler.fire()).toBe(GRANT_RETRY_MS);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing once its socket ended, even with a fetch in flight", async () => {
    const scheduler = manualScheduler();
    const sent: ClientMessage[] = [];
    let release: (token: string) => void = ignore;
    const stop = keepGrant({
      ttlMs: 300_000,
      grant: () => new Promise<string>((resolve) => (release = resolve)),
      send: (message) => sent.push(message),
      scheduler,
      id: () => "r",
    });
    await scheduler.fire();
    stop();
    release(grant(300_000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(scheduler.live()).toEqual([]);
  });
});
