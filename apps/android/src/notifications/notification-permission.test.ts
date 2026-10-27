import { expect, test } from "vitest";
import {
  applyMachineMute,
  isDeliveringToMachine,
  NOTIFICATION_LIMITS_COPY,
  shouldAskNotificationPermission,
} from "./notification-permission.ts";

test("permission is asked once, after the first thread, never at first launch", () => {
  const base = { asked: false, permission: "notDetermined" as const };
  expect(shouldAskNotificationPermission({ ...base, hasReadyPairedMachineWithThread: false })).toBe(
    false,
  );
  expect(shouldAskNotificationPermission({ ...base, hasReadyPairedMachineWithThread: true })).toBe(
    true,
  );
  expect(
    shouldAskNotificationPermission({
      ...base,
      hasReadyPairedMachineWithThread: true,
      asked: true,
    }),
  ).toBe(false);
  expect(
    shouldAskNotificationPermission({
      ...base,
      hasReadyPairedMachineWithThread: true,
      permission: "denied",
    }),
  ).toBe(false);
  expect(
    shouldAskNotificationPermission({
      ...base,
      hasReadyPairedMachineWithThread: true,
      permission: "allowed",
    }),
  ).toBe(false);
});

test("delivery needs the switch, the system permission and an unmuted machine", () => {
  const base = { enabled: true, permission: "allowed" as const, mutedMachines: [] as string[] };
  expect(isDeliveringToMachine({ ...base, hostId: "host-a" })).toBe(true);
  expect(isDeliveringToMachine({ ...base, enabled: false, hostId: "host-a" })).toBe(false);
  expect(isDeliveringToMachine({ ...base, permission: "denied", hostId: "host-a" })).toBe(false);
  expect(isDeliveringToMachine({ ...base, permission: "notDetermined", hostId: "host-a" })).toBe(
    false,
  );
  expect(isDeliveringToMachine({ ...base, mutedMachines: ["host-a"], hostId: "host-a" })).toBe(
    false,
  );
  expect(isDeliveringToMachine({ ...base, mutedMachines: ["host-a"], hostId: "host-b" })).toBe(
    true,
  );
});

test("muting one machine never touches the others and stays sorted", () => {
  expect(applyMachineMute([], "host-b", false)).toEqual(["host-b"]);
  expect(applyMachineMute(["host-b", "host-a"], "host-b", true)).toEqual(["host-a"]);
  expect(applyMachineMute(["host-b"], "host-a", false)).toEqual(["host-a", "host-b"]);
  // Toggling twice is idempotent.
  expect(applyMachineMute(applyMachineMute([], "host-a", false), "host-a", false)).toEqual([
    "host-a",
  ]);
});

test("the settings copy discloses best-effort background delivery", () => {
  expect(NOTIFICATION_LIMITS_COPY).toMatch(/best effort/i);
  expect(NOTIFICATION_LIMITS_COPY).toMatch(/remote push is not used/i);
});
