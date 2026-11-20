import { expect, test } from "vitest";
import { TunnelAdmission, tunnelAccess, visiblePorts } from "./policy.ts";

const open = { enabled: true, operate: true, port: 3000, acePorts: new Set([7777]) };

test.each([
  [{ enabled: false, operate: true }, "tunnel_off"],
  [{ enabled: false, operate: false }, "tunnel_off"],
  [{ enabled: true, operate: false }, "tunnel_forbidden"],
  [{ enabled: true, operate: true }, undefined],
] as const)("the tunnel as a whole for %j: %s", (facts, expected) => {
  expect(tunnelAccess(facts)).toBe(expected);
});

test("a port an ace process listens on is refused whatever the device asks", () => {
  const admission = new TunnelAdmission(() => 0);
  expect(admission.admit("phone", "1", { ...open, port: 7777 })).toBe("tunnel_port_refused");
  expect(admission.admit("phone", "2", open)).toBeUndefined();
});

test("a read-only device or a tunnel turned off is refused before ports or limits", () => {
  const admission = new TunnelAdmission(() => 0);
  expect(admission.admit("phone", "1", { ...open, port: 7777, operate: false })).toBe(
    "tunnel_forbidden",
  );
  expect(admission.admit("phone", "1", { ...open, enabled: false })).toBe("tunnel_off");
});

test("a device holds at most its stream limit, and a closed stream frees its slot", () => {
  const limits = { streamsPerDevice: 2, opensPerSecond: 1000, openBurst: 1000 };
  const admission = new TunnelAdmission(() => 0, limits);
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
  const limits = { streamsPerDevice: 100, opensPerSecond: 10, openBurst: 3 };
  const admission = new TunnelAdmission(() => now, limits);
  const opened = [1, 2, 3, 4].map((n) => admission.admit("phone", `${n}`, open));
  expect(opened).toEqual([undefined, undefined, undefined, "tunnel_limit"]);
  now += 99;
  expect(admission.admit("phone", "5", open)).toBe("tunnel_limit");
  now += 2; // 101 ms at 10 per second: one more open.
  expect(admission.admit("phone", "6", open)).toBeUndefined();
  expect(admission.admit("phone", "7", open)).toBe("tunnel_limit");
});

test("releasing a stream that was never admitted changes nothing", () => {
  const limits = { streamsPerDevice: 1, opensPerSecond: 1000, openBurst: 1000 };
  const admission = new TunnelAdmission(() => 0, limits);
  expect(admission.admit("phone", "a", open)).toBeUndefined();
  admission.release("phone", "refused");
  expect(admission.admit("phone", "b", open)).toBe("tunnel_limit");
});

test("the ports a device sees leave out ace's own, ascending and bounded", () => {
  expect(visiblePorts([5173, 22, 7777, 3000, 3000], new Set([7777]), 10)).toEqual([22, 3000, 5173]);
  expect(visiblePorts([4, 3, 2, 1], new Set(), 2)).toEqual([1, 2]);
});
