import { expect, it } from "vitest";
import { NK_LIMITS, NkAdmission } from "./admission.ts";

// What an NK first message may cost the daemon before its client confirms (ADR 0155, step 2):
// each limit exhausted, confirmed sessions unaffected, and everything given back.

function clock() {
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms: number, run: () => void) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer) >>> 0, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
    pending: () => timers.length,
  };
}

const key = (n: number) => new Uint8Array(32).fill(n % 256).map((b, i) => (i === 0 ? n >> 8 : b));

it("the daemon decrypts at most 40 first messages at once and 20 a second after that", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  let taken = 0;
  for (let n = 0; n < 100; n++) if (admission.arrive()) taken++;
  expect(taken).toBe(40);
  time.advance(1_000);
  taken = 0;
  for (let n = 0; n < 100; n++) if (admission.arrive()) taken++;
  expect(taken).toBe(20);
});

it("one claimed device gets 4 at once and 2 a second, and doesn't use another's room", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  const results = Array.from({ length: 10 }, () => admission.claim("phone"));
  expect(results.filter(Boolean)).toHaveLength(4);
  expect(admission.claim("tablet")).toBe(true);
  time.advance(1_000);
  expect([admission.claim("phone"), admission.claim("phone"), admission.claim("phone")]).toEqual([
    true,
    true,
    false,
  ]);
});

it("a flood of made-up device ids can't grow the rate table past its bound, and idle ids make room", () => {
  const time = clock();
  const admission = new NkAdmission(time, { ...NK_LIMITS, trackedDevices: 8 });
  for (let n = 0; n < 8; n++) expect(admission.claim(`fake-${n}`)).toBe(true);
  expect(admission.claim("real")).toBe(false);
  // Once their buckets refill they are forgotten, and a new id is tracked.
  time.advance(2_000);
  expect(admission.claim("real")).toBe(true);
});

it("an identical first message is refused for 5 minutes, a refused attempt's key is given back, and a full set refuses", () => {
  const time = clock();
  const admission = new NkAdmission(time, { ...NK_LIMITS, suppressEntries: 3 });
  expect(admission.suppress(key(1))).not.toBeTypeOf("string");
  expect(admission.suppress(key(1))).toBe("seen");
  const refused = admission.suppress(key(2));
  if (typeof refused === "string") throw new Error("expected a claim");
  refused.release();
  expect(admission.suppress(key(2))).not.toBeTypeOf("string");
  expect(admission.suppress(key(3))).not.toBeTypeOf("string");
  // Full: refused, nothing forgotten early.
  expect(admission.suppress(key(4))).toBe("full");
  expect(admission.suppress(key(1))).toBe("seen");
  time.advance(NK_LIMITS.suppressMs);
  expect(admission.suppress(key(1))).not.toBeTypeOf("string");
  expect(admission.held().suppressed).toBe(1);
});

it("a device holds at most 2 unconfirmed sessions and the daemon 32; a confirmed one frees its place", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  const first = admission.admit("phone", () => {});
  const second = admission.admit("phone", () => {});
  expect(first && second).toBeTruthy();
  expect(admission.admit("phone", () => {})).toBeUndefined();
  first?.confirm();
  // Confirmed sessions keep working with no limits, and no longer count.
  expect(first?.output(10 * 1024 * 1024)).toBe(true);
  expect(admission.admit("phone", () => {})).toBeDefined();
  const others = Array.from({ length: 40 }, (_, n) => admission.admit(`device-${n}`, () => {}));
  expect(others.filter(Boolean)).toHaveLength(30);
  for (const session of others) session?.close();
  expect(admission.admit("device-x", () => {})).toBeDefined();
});

it("a device gets at most 6 NK attempts a minute, whether or not they confirm", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  for (let n = 0; n < 6; n++) admission.admit("phone", () => {})?.confirm();
  expect(admission.admit("phone", () => {})).toBeUndefined();
  time.advance(60_001);
  expect(admission.admit("phone", () => {})).toBeDefined();
});

it("an unconfirmed session holds at most 8 MiB, all of them 64 MiB, and confirming or closing gives it back", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  const mib = 1024 * 1024;
  const sessions = Array.from({ length: 9 }, (_, n) => admission.admit(`d${n}`, () => {}));
  const [first] = sessions;
  expect(first?.reserveBytes(8 * mib)).toBe(true);
  expect(first?.reserveBytes(1)).toBe(false);
  for (const session of sessions.slice(1, 8)) expect(session?.reserveBytes(8 * mib)).toBe(true);
  expect(admission.held().bytes).toBe(64 * mib);
  // The ninth has its own room but the daemon has none.
  expect(sessions[8]?.reserveBytes(1)).toBe(false);
  first?.confirm();
  expect(sessions[8]?.reserveBytes(8 * mib)).toBe(true);
  for (const session of sessions) session?.close();
  expect(admission.held()).toMatchObject({ sessions: 0, bytes: 0 });
});

it("an unconfirmed session replays at most 2,000 events and sends at most 256 KiB, then waits", () => {
  const admission = new NkAdmission(clock());
  const session = admission.admit("phone", () => {});
  expect(session?.reserveEvents(1_500)).toBe(true);
  expect(session?.reserveEvents(501)).toBe(false);
  expect(session?.reserveEvents(500)).toBe(true);
  expect(session?.output(200 * 1024)).toBe(true);
  expect(session?.output(57 * 1024)).toBe(false);
  expect(session?.output(56 * 1024)).toBe(true);
  session?.confirm();
  expect(session?.reserveEvents(1_000_000)).toBe(true);
  expect(session?.output(64 * 1024 * 1024)).toBe(true);
});

it("a session that doesn't confirm in 5 s is closed and gives everything back; one that does keeps going", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  const expired: string[] = [];
  const late = admission.admit("phone", () => expired.push("phone"));
  const prompt = admission.admit("tablet", () => expired.push("tablet"));
  late?.reserveBytes(1024);
  prompt?.reserveBytes(1024);
  time.advance(4_000);
  prompt?.confirm();
  time.advance(1_000);
  expect(expired).toEqual(["phone"]);
  expect(late?.reserveBytes(1)).toBe(false);
  expect(prompt?.output(1024 * 1024)).toBe(true);
  expect(admission.held()).toMatchObject({ sessions: 0, bytes: 0 });
  expect(time.pending()).toBe(0);
});

it("every refusal goes out the same time after its first message arrived", () => {
  const time = clock();
  const admission = new NkAdmission(time);
  const arrived = time.now();
  expect(admission.refusalDelay(arrived)).toBe(NK_LIMITS.refusalMs);
  time.advance(40);
  expect(admission.refusalDelay(arrived)).toBe(NK_LIMITS.refusalMs - 40);
  time.advance(1_000);
  expect(admission.refusalDelay(arrived)).toBe(0);
});
