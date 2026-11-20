import { expect, it } from "vitest";
import { HostId, type DeviceContextItem } from "@ace/protocol";
import { deviceContextText } from "./device-context.ts";

const studio = {
  hostId: HostId.parse("host-studio"),
  profile: "studio",
  name: "Studio",
  status: "online" as const,
};
const simulator: DeviceContextItem = {
  type: "device",
  id: "SIM-1",
  name: "iPhone 17",
  kind: "simulator",
  machine: { id: "host-studio", name: "Studio", here: false },
  os: "iOS 26.0",
  online: true,
};

it("picking a device tells the agent which it is and how to reach it with its tools", () => {
  const text = deviceContextText(simulator, [studio]) ?? "";
  expect(text).toContain(
    '<device id="SIM-1" machine="host-studio" kind="simulator" online="true">',
  );
  expect(text).toContain('"iPhone 17", an iOS simulator, iOS 26.0, on the machine "Studio"');
  expect(text).toContain('passing machine "studio" to delegate, run, browser and screen tools');
  expect(text).toContain('device id "SIM-1"');
});

it("an offline device is named, and the agent is told not to try it", () => {
  const text = deviceContextText(simulator, [{ ...studio, status: "offline" }]) ?? "";
  expect(text).toContain('online="false"');
  expect(text).toContain("It is offline now: don't try to use it");
});

it("a device on a machine this one no longer links to is left out", () => {
  expect(deviceContextText(simulator, [])).toBeUndefined();
});

it("this machine needs no link and is named as where the agent runs", () => {
  const here: DeviceContextItem = {
    type: "device",
    id: "primary",
    name: "omarchy",
    kind: "server",
    machine: { id: "primary", name: "omarchy", here: true },
    os: "Linux",
    online: true,
  };
  expect(deviceContextText(here, [])).toContain("This machine (Linux)");
});
