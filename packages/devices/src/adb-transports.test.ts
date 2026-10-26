import { expect, it } from "vitest";
import { adbTransports, physicalIdPart } from "./adb-transports.ts";

it("every adb state reads as booted, offline or unauthorized, and unknown ones are kept as offline", () => {
  const listed = adbTransports(
    [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1",
      "R58M123ABC             authorizing usb:1-1 transport_id:2",
      "HT7A1A02345            recovery usb:1-2 product:marlin transport_id:3",
      "[fe80::1]:5555         connecting",
      "adb-HT7A1-AbC._adb._tcp sideload",
      "0A1B2C3D               future-state usb:2-1",
      "ZY22                   no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:2-2 transport_id:9",
    ].join("\n"),
  );
  expect(listed).toEqual([
    {
      serial: "emulator-5554",
      kind: "emulator",
      state: "booted",
      model: "sdk gphone64 x86 64",
    },
    { serial: "R58M123ABC", kind: "usb", state: "unauthorized", block: "unauthorized", usb: "1-1" },
    { serial: "HT7A1A02345", kind: "usb", state: "offline", usb: "1-2" },
    { serial: "[fe80::1]:5555", kind: "network", state: "offline" },
    { serial: "adb-HT7A1-AbC._adb._tcp", kind: "network", state: "offline" },
    { serial: "0A1B2C3D", kind: "usb", state: "offline", usb: "2-1" },
    { serial: "ZY22", kind: "usb", state: "unauthorized", block: "no_permissions", usb: "2-2" },
  ]);
});

it("device ids keep to the characters ids allow, so an address still names one device", () => {
  expect(physicalIdPart({ serial: "[fe80::1]:5555" })).toBe("_fe80__1__5555");
  expect(physicalIdPart({ serial: "192.168.1.5:5555" })).toBe("192.168.1.5_5555");
  expect(physicalIdPart({ serial: "192.168.1.5:5555" }, "R58M123ABC")).toBe("R58M123ABC");
});
