import { describe, expect, it } from "vitest";
import { signGrant } from "@ace/account-grant";
import type { ClientMessage } from "@ace/protocol";
import {
  GRANT_RETRY_MS,
  grantRefreshDelay,
  keepGrant,
  refreshRefusalIsFinal,
} from "./grant-keeper.ts";

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

/** A keeper on a socket whose welcome said `ttlMs`, fetching grants that last `lifetimeMs`. */
function keeper(options: { ttlMs?: number; lifetimeMs?: number; fetch?: () => Promise<string> }) {
  const scheduler = manualScheduler();
  const sent: Extract<ClientMessage, { type: "account.grant.refresh" }>[] = [];
  const refused: string[] = [];
  let ids = 0;
  const keeping = keepGrant({
    ttlMs: options.ttlMs ?? 300_000,
    grant: options.fetch ?? (async () => grant(options.lifetimeMs ?? 300_000)),
    send: (message) => {
      if (message.type === "account.grant.refresh") sent.push(message);
    },
    scheduler,
    id: () => `r${++ids}`,
    refused: (code) => refused.push(code),
  });
  const answer = (
    result: { ok: true; grantTtlMs: number } | { ok: false; code: string; message: string },
    requestId = sent.at(-1)?.requestId ?? "",
  ) => keeping.answered({ type: "account.grant.refresh.result", requestId, result });
  return { scheduler, sent, refused, keeping, answer };
}

describe("keeping a socket's grant fresh", () => {
  it("sends a new grant before the welcome's runs out, then times the next from the answer", async () => {
    const k = keeper({ ttlMs: 200_000 });
    expect(k.sent).toEqual([]);
    expect(await k.scheduler.fire()).toBe(140_000);
    expect(k.sent).toEqual([
      { type: "account.grant.refresh", requestId: "r1", grant: grant(300_000) },
    ]);
    k.answer({ ok: true, grantTtlMs: 300_000 });
    expect(await k.scheduler.fire()).toBe(240_000);
    expect(k.sent).toHaveLength(2);
  });

  it("refreshes early enough when the daemon's clock runs ahead of the backend's", async () => {
    // The daemon is two minutes ahead: a fresh five-minute grant has three minutes there.
    const k = keeper({ ttlMs: 180_000 });
    expect(await k.scheduler.fire()).toBe(120_000);
    k.answer({ ok: true, grantTtlMs: 180_000 });
    // Timed from what the daemon says is left, not the grant's own five minutes.
    expect(await k.scheduler.fire()).toBe(120_000);
    expect(k.sent).toHaveLength(2);
  });

  it("never waits past the new grant's own lifetime, even if the daemon says it has longer", async () => {
    const k = keeper({ lifetimeMs: 100_000 });
    await k.scheduler.fire();
    k.answer({ ok: true, grantTtlMs: 300_000 });
    expect(await k.scheduler.fire()).toBe(50_000);
  });

  it("tries again shortly when a refresh is refused for a passing reason", async () => {
    const k = keeper({});
    await k.scheduler.fire();
    k.answer({ ok: false, code: "unauthorized", message: "Couldn't check it. Try again." });
    expect(await k.scheduler.fire()).toBe(GRANT_RETRY_MS);
    expect(k.sent).toHaveLength(2);
    expect(k.refused).toEqual([]);
  });

  it("stops and hands over at once when the machine wants its code", async () => {
    const k = keeper({});
    await k.scheduler.fire();
    k.answer({ ok: false, code: "machine_code_required", message: "Enter it" });
    expect(k.refused).toEqual(["machine_code_required"]);
    expect(k.scheduler.live()).toEqual([]);
  });

  it("stops and hands over when the machine refuses this account's grant twice in a row", async () => {
    const k = keeper({});
    await k.scheduler.fire();
    // Once may be the daemon briefly unable to check the grant: it tries again shortly.
    k.answer({ ok: false, code: "unauthorized", message: "Try again" });
    expect(k.refused).toEqual([]);
    expect(await k.scheduler.fire()).toBe(GRANT_RETRY_MS);
    k.answer({ ok: false, code: "unauthorized", message: "No" });
    expect(k.refused).toEqual(["unauthorized"]);
    expect(k.scheduler.live()).toEqual([]);
  });

  it("tries again with a fresh grant when a refresh goes unanswered", async () => {
    const k = keeper({});
    await k.scheduler.fire();
    expect(await k.scheduler.fire()).toBe(GRANT_RETRY_MS);
    expect(k.sent.map((message) => message.requestId)).toEqual(["r1", "r2"]);
    // A late answer to the first refresh no longer times anything.
    k.answer({ ok: true, grantTtlMs: 1_000 }, "r1");
    expect(k.scheduler.live().map((timer) => timer.delayMs)).toEqual([GRANT_RETRY_MS]);
  });

  it("tries again shortly when a grant can't be fetched", async () => {
    let fetches = 0;
    const k = keeper({
      fetch: async () => {
        if (++fetches === 1) throw new Error("offline");
        return grant(300_000);
      },
    });
    await k.scheduler.fire();
    expect(k.sent).toEqual([]);
    expect(await k.scheduler.fire()).toBe(GRANT_RETRY_MS);
    expect(k.sent).toHaveLength(1);
  });

  it("sends nothing once its socket ended, even with a fetch in flight", async () => {
    let release: (token: string) => void = ignore;
    const k = keeper({ fetch: () => new Promise<string>((resolve) => (release = resolve)) });
    await k.scheduler.fire();
    k.keeping.stop();
    release(grant(300_000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(k.sent).toEqual([]);
    expect(k.scheduler.live()).toEqual([]);
  });
});

describe("a refused refresh", () => {
  it.each([
    { code: "machine_code_required", previous: undefined, final: true },
    { code: "machine_code_locked", previous: undefined, final: true },
    { code: "unauthorized", previous: undefined, final: false },
    { code: "unauthorized", previous: "unauthorized", final: true },
    { code: "unauthorized", previous: "machine_code_wrong", final: false },
    { code: "unavailable", previous: "unavailable", final: false },
  ])("$code after $previous is final: $final", ({ code, previous, final }) => {
    expect(refreshRefusalIsFinal(code, previous)).toBe(final);
  });
});
