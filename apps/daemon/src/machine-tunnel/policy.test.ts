import { expect, test } from "vitest";
import { TunnelAdmission, tunnelAccess, visiblePorts, type TunnelLimits } from "./policy.ts";

const open = { enabled: true, operate: true };
const roomy: TunnelLimits = {
  streamsPerDevice: 100,
  opensPerSecond: 1000,
  openBurst: 1000,
  pendingOpens: 100,
};

test.each([
  [{ enabled: false, operate: true }, "tunnel_off"],
  [{ enabled: false, operate: false }, "tunnel_off"],
  [{ enabled: true, operate: false }, "tunnel_forbidden"],
  [{ enabled: true, operate: true }, undefined],
] as const)("the tunnel as a whole for %j: %s", (facts, expected) => {
  expect(tunnelAccess(facts)).toBe(expected);
});

test("a read-only device or a tunnel turned off is refused before any limit", () => {
  const admission = new TunnelAdmission(() => 0, { ...roomy, openBurst: 1 });
  expect(admission.admit("phone", "1", { ...open, operate: false })).toBe("tunnel_forbidden");
  expect(admission.admit("phone", "1", { ...open, enabled: false })).toBe("tunnel_off");
  // Neither spent the device's one open.
  expect(admission.admit("phone", "1", open)).toBeUndefined();
});

test("a device holds at most its stream limit, and a closed stream frees its slot", () => {
  const admission = new TunnelAdmission(() => 0, { ...roomy, streamsPerDevice: 2 });
  expect(admission.admit("phone", "a", open)).toBeUndefined();
  expect(admission.admit("phone", "b", open)).toBeUndefined();
  expect(admission.admit("phone", "c", open)).toBe("tunnel_limit");
  // Another device has its own slots.
  expect(admission.admit("laptop", "a", open)).toBeUndefined();
  admission.release("phone", "a");
  expect(admission.admit("phone", "c", open)).toBeUndefined();
  expect(admission.open("phone")).toBe(2);
});

test("opens beyond the burst wait for the rate to refill", () => {
  let now = 0;
  const admission = new TunnelAdmission(() => now, { ...roomy, opensPerSecond: 10, openBurst: 3 });
  const opened = [1, 2, 3, 4].map((n) => admission.admit("phone", `${n}`, open));
  expect(opened).toEqual([undefined, undefined, undefined, "tunnel_limit"]);
  now += 99;
  expect(admission.admit("phone", "5", open)).toBe("tunnel_limit");
  now += 2; // 101 ms at 10 per second: one more open.
  expect(admission.admit("phone", "6", open)).toBeUndefined();
  expect(admission.admit("phone", "7", open)).toBe("tunnel_limit");
});

test("every open is charged, even one refused for the stream limit", () => {
  const admission = new TunnelAdmission(() => 0, {
    ...roomy,
    streamsPerDevice: 1,
    openBurst: 3,
  });
  expect(admission.admit("phone", "a", open)).toBeUndefined();
  expect(admission.admit("phone", "b", open)).toBe("tunnel_limit");
  admission.release("phone", "a");
  // Two opens were spent; the third is the last in the burst.
  expect(admission.admit("phone", "c", open)).toBeUndefined();
  admission.release("phone", "c");
  expect(admission.admit("phone", "d", open)).toBe("tunnel_limit");
});

test("opening and closing one stream at a time never refills the bucket", () => {
  const admission = new TunnelAdmission(() => 0, { ...roomy, openBurst: 5 });
  const results: (string | undefined)[] = [];
  for (let n = 0; n < 8; n++) {
    results.push(admission.admit("phone", `${n}`, open));
    admission.release("phone", `${n}`);
  }
  expect(results).toEqual([
    ...Array.from({ length: 5 }, () => undefined),
    "tunnel_limit",
    "tunnel_limit",
    "tunnel_limit",
  ]);
});

test("opens waiting for authorization are bounded across every device", () => {
  const admission = new TunnelAdmission(() => 0, { ...roomy, pendingOpens: 2 });
  expect(admission.admit("phone", "a", open)).toBeUndefined();
  expect(admission.admit("laptop", "a", open)).toBeUndefined();
  expect(admission.admit("tablet", "a", open)).toBe("tunnel_limit");
  expect(admission.pending()).toBe(2);
  // An authorized stream stays open but no longer waits.
  admission.authorized("phone", "a");
  expect(admission.admit("tablet", "a", open)).toBeUndefined();
  // A stream released while it waited stops waiting too.
  admission.release("laptop", "a");
  expect(admission.pending()).toBe(1);
  expect(admission.holds("laptop", "a")).toBe(false);
  expect(admission.holds("phone", "a")).toBe(true);
});

test("releasing a stream that was never admitted changes nothing", () => {
  const admission = new TunnelAdmission(() => 0, { ...roomy, streamsPerDevice: 1 });
  expect(admission.admit("phone", "a", open)).toBeUndefined();
  admission.release("phone", "refused");
  expect(admission.admit("phone", "b", open)).toBe("tunnel_limit");
});

test("the ports a device sees leave out ace's own, ascending and bounded", () => {
  expect(visiblePorts([5173, 22, 7777, 3000, 3000], new Set([7777]), 10)).toEqual([22, 3000, 5173]);
  expect(visiblePorts([4, 3, 2, 1], new Set(), 2)).toEqual([1, 2]);
});
