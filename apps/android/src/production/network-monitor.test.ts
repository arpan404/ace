import { expect, it } from "vitest";
import { networkChange } from "./network-monitor.ts";

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
