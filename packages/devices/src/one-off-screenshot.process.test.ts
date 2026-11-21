import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { DevicePlatform } from "./index.ts";
import { busyJpeg, flatPng, imageHeader, mediaBinary, testImages } from "./testing/media-images.ts";

/* Screenshots are fitted by ace-media (ADR 0208); without a built binary these don't run. */
const drawn = it.skipIf(!mediaBinary);

async function androidPlatform(screen: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "ace-one-off-shot-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const path of ["platform-tools/adb", "emulator/emulator"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, path), 0o700);
  }
  const commands: string[] = [];
  const platform = new DevicePlatform({
    platform: "linux",
    home: root,
    env: { ANDROID_HOME: root },
    images: testImages,
    async probe(_command, args) {
      const command = args.join(" ");
      let stdout = "";
      if (command === "-list-avds") stdout = "Pixel";
      else if (command === "devices -l")
        stdout = "List of devices attached\nemulator-5554 device model:Pixel";
      else if (command.endsWith("emu avd name")) stdout = "Pixel\nOK";
      // Identity checks that the emulator is still the same AVD are not the screenshot's effects.
      else if (!command.includes("getprop")) commands.push(command);
      // `adb pull GUEST LOCAL` copies the device's capture to this machine.
      if (args.includes("pull")) await writeFile(args.at(-1) ?? "", screen);
      return { stdout, stderr: "", code: 0 };
    },
  });
  onTestFinished(() => platform.close());
  return { platform, commands };
}

drawn(
  "an emulator screenshot is captured on the device, pulled, removed, and fitted to a frame",
  async () => {
    const png = await flatPng(1080, 2400, [200, 0, 0]);
    const { platform, commands } = await androidPlatform(png);
    const [device] = await platform.list();
    if (!device) throw new Error("No emulator");
    const shot = await platform.screenshot(device);
    // A portrait phone is fitted inside the frame packet's 2160-pixel height.
    expect(shot).toMatchObject({ width: 972, height: 2160, scale: 0.9 });
    expect(await imageHeader(shot.payload)).toEqual({ format: "jpeg", width: 972, height: 2160 });
    const guest = /'screencap' '-p' '(\/data\/local\/tmp\/ace-shot-[^']+\.png)'/.exec(
      commands.join("\n"),
    )?.[1];
    expect(guest).toBeDefined();
    expect(commands).toEqual([
      `-s emulator-5554 shell 'screencap' '-p' '${guest}'`,
      expect.stringMatching(new RegExp(`^-s emulator-5554 pull ${guest} `)),
      `-s emulator-5554 shell 'rm' '-f' '${guest}'`,
    ]);
  },
);

drawn("a screenshot that is not an image fails as invalid data", async () => {
  const { platform } = await androidPlatform(Buffer.from("not an image"));
  const [device] = await platform.list();
  if (!device) throw new Error("No emulator");
  await expect(platform.screenshot(device)).rejects.toMatchObject({ code: "invalid_data" });
});

drawn(
  "a screenshot cut short, PNG or JPEG, fails as invalid data rather than showing a partial screen",
  async () => {
    for (const whole of [
      await flatPng(1080, 2400, [128, 128, 128]),
      await busyJpeg(1080, 2400, 90),
    ]) {
      const { platform } = await androidPlatform(whole.subarray(0, Math.floor(whole.length * 0.6)));
      const [device] = await platform.list();
      if (!device) throw new Error("No emulator");
      await expect(platform.screenshot(device)).rejects.toMatchObject({ code: "invalid_data" });
    }
  },
);

// Read-only against whatever is already booted: set ACE_DEVICE_LIVE=1 to run.
const live = process.env["ACE_DEVICE_LIVE"] === "1";
it.skipIf(!live)("booted real simulators and emulators give a one-off JPEG", async () => {
  const platform = new DevicePlatform({
    platform: process.platform,
    home: process.env["ACE_TEST_REAL_HOME"] ?? homedir(),
    env: process.env,
  });
  onTestFinished(() => platform.close());
  const booted = (await platform.list()).filter((device) => device.state === "booted");
  if (!booted.length) throw new Error("Boot a simulator or emulator for the live test");
  for (const device of booted.slice(0, 2)) {
    const started = performance.now();
    const shot = await platform.screenshot(device);
    const elapsed = Math.round(performance.now() - started);
    process.stdout.write(
      `${device.id}: ${shot.width}x${shot.height} scale ${shot.scale}, ${shot.payload.length} bytes, ${elapsed} ms\n`,
    );
    expect(shot.payload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }
});
