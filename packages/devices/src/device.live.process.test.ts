import { homedir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { DevicePlatform } from "./index.ts";
const live = process.env["ACE_DEVICE_LIVE"] === "1";
function platform() {
  const devices = new DevicePlatform({
    platform: process.platform,
    home: homedir(),
    env: process.env,
  });
  onTestFinished(() => devices.close());
  return devices;
}
it.skipIf(!live)("installed SDKs expose their real simulator and emulator inventory", async () => {
  expect(await platform().list()).not.toHaveLength(0);
});
for (const kind of ["ios", "android"] as const) {
  const native =
    process.env[kind === "ios" ? "ACE_DEVICE_LIVE_IOS_UUID" : "ACE_DEVICE_LIVE_ANDROID_AVD"];
  it.skipIf(!live || !native)(
    `boots and shuts down the explicitly selected real ${kind} device`,
    async () => {
      const devices = platform();
      const selected = (await devices.list()).find((device) => device.id === `${kind}:${native}`);
      if (!selected) throw new Error("The explicitly selected device is not installed");
      if (selected.state !== "shutdown")
        throw new Error("Live lifecycle tests require an initially shut down device");
      await devices.boot(selected);
      onTestFinished(async () => {
        await devices.shutdown(selected).catch(() => {});
      });
      expect((await devices.list()).find((device) => device.id === selected.id)?.state).toBe(
        "booted",
      );
      await devices.shutdown(selected);
      expect((await devices.list()).find((device) => device.id === selected.id)?.state).toBe(
        "shutdown",
      );
    },
  );
}
