import { expect, it } from "vitest";
import { networkChange, snapshotNetworkState } from "./network-monitor.ts";

it("the first sighting only sets the baseline and propagates nothing", () => {
  expect(networkChange(undefined, { online: true, iface: "WIFI" })).toBeNull();
  expect(networkChange(undefined, { online: false, iface: "NONE" })).toBeNull();
});

it("a steady state propagates nothing", () => {
  expect(
    networkChange({ online: true, iface: "WIFI" }, { online: true, iface: "WIFI" }),
  ).toBeNull();
  expect(
    networkChange({ online: false, iface: "NONE" }, { online: false, iface: "NONE" }),
  ).toBeNull();
});

it("offline to online propagates without an interface change", () => {
  expect(networkChange({ online: false, iface: "NONE" }, { online: true, iface: "WIFI" })).toEqual({
    online: true,
    interfaceChanged: true,
  });
});

it("a Wi-Fi to cellular or VPN hop flags the interface change", () => {
  expect(
    networkChange({ online: true, iface: "WIFI" }, { online: true, iface: "CELLULAR" }),
  ).toEqual({ online: true, interfaceChanged: true });
  expect(networkChange({ online: true, iface: "WIFI" }, { online: true, iface: "VPN" })).toEqual({
    online: true,
    interfaceChanged: true,
  });
});

it("dropping offline on the same interface reports no interface change", () => {
  expect(networkChange({ online: true, iface: "WIFI" }, { online: false, iface: "WIFI" })).toEqual({
    online: false,
    interfaceChanged: false,
  });
});

it("a fast network read maps to a snapshot baseline", async () => {
  await expect(
    snapshotNetworkState(async () => ({ isConnected: true, type: "WIFI" }), 1000),
  ).resolves.toEqual({ online: true, iface: "WIFI" });
  await expect(
    snapshotNetworkState(async () => ({ isConnected: undefined, type: 7 }), 1000),
  ).resolves.toEqual({ online: false, iface: "unknown" });
});

it("a hung network read falls back to undefined so startup stays recoverable", async () => {
  // Deferred real edge: `getNetworkStateAsync` never settles. Startup must
  // still reach the lock (baseline `undefined` propagates nothing) instead
  // of stalling on an opaque opener; the late read changes nothing.
  let resolveLate!: (value: { isConnected: boolean; type: string }) => void;
  const hanging = new Promise<{ isConnected: boolean; type: string }>((resolve) => {
    resolveLate = resolve;
  });
  hanging.then(undefined, () => undefined);
  await expect(snapshotNetworkState(() => hanging, 10)).resolves.toBeUndefined();
  resolveLate({ isConnected: true, type: "WIFI" });
  await hanging;
  await Promise.resolve();
});

it("a failing network read falls back to undefined instead of stalling", async () => {
  await expect(
    snapshotNetworkState(async () => {
      throw new Error("radio gone");
    }, 1000),
  ).resolves.toBeUndefined();
  await expect(
    snapshotNetworkState(() => Promise.reject(new Error("offline")), 1000),
  ).resolves.toBeUndefined();
});
