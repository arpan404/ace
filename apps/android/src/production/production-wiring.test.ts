import { expect, it } from "vitest";
import { MachineEntry } from "@ace/client/machines";
import {
  canActMachines,
  machineCards,
  routeMessage,
  selectActiveHost,
} from "./production-wiring.ts";

const PIN = "9f".repeat(32);

function direct(hostId: string, deviceId = "phone-1"): MachineEntry {
  return MachineEntry.parse({
    hostId,
    displayName: hostId,
    target: { kind: "direct", url: "wss://192.168.1.20:4243/", fingerprint: PIN },
    deviceId,
  });
}

it("keeps the preferred machine while paired and falls back to the first", () => {
  const entries = [direct("host-1"), direct("host-2")];
  expect(selectActiveHost(entries, "host-2")).toBe("host-2");
  expect(selectActiveHost(entries, "gone")).toBe("host-1");
  expect(selectActiveHost(entries)).toBe("host-1");
  expect(selectActiveHost([])).toBeUndefined();
});

it("builds one card per machine with its grant and route", () => {
  const entries = [direct("host-1"), direct("host-2")];
  const cards = machineCards({
    entries,
    canOperate: (hostId) => hostId === "host-1",
    route: (hostId) =>
      hostId === "host-1"
        ? { route: "paired" }
        : { route: "pairing", reason: "revoked", message: "This machine needs pairing again." },
  });
  expect(cards).toHaveLength(2);
  expect(cards[0]).toMatchObject({
    hostId: "host-1",
    canOperate: true,
    route: { route: "paired" },
  });
  expect(cards[1]?.canOperate).toBe(false);
  expect(routeMessage(cards[1]?.route ?? { route: "paired" })).toBe(
    "This machine needs pairing again.",
  );
  expect(routeMessage({ route: "paired" })).toBeNull();
});

it("machine actions fail closed without an explicit grant", () => {
  expect(canActMachines(true)).toBe(true);
  expect(canActMachines(false)).toBe(false);
  expect(canActMachines(undefined)).toBe(false);
});
