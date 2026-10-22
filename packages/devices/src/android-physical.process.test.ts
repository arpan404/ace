import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { nodeBinary } from "@ace/provider-kit/testing";
import { DevicePlatform, type Device } from "./index.ts";

/**
 * Phones and network devices through a distribution's adb on PATH (no Android SDK): `adb devices
 * -l` prints DEVICE_LIST; each serial's `ro.serialno` and release come from DEVICE_PROPS.
 */
async function fixture(options: { arch?: string; sdkEmulator?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-android-physical-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  const journal = join(home, "commands.jsonl");
  const list = join(home, "devices.txt");
  const props = join(home, "props.json");
  await Promise.all([writeFile(journal, ""), writeFile(list, ""), writeFile(props, "{}")]);
  await nodeBinary(
    bin,
    "adb",
    `const fs = require('node:fs'); const args = process.argv.slice(2);
    fs.appendFileSync(process.env.DEVICE_JOURNAL, JSON.stringify({tool: 'adb', args})+'\\n');
    if (args[0] === 'devices') { console.log('List of devices attached\\n' + fs.readFileSync(process.env.DEVICE_LIST,'utf8')); process.exit(0); }
    const serial = args[1];
    const known = JSON.parse(fs.readFileSync(process.env.DEVICE_PROPS,'utf8'))[serial];
    if (!known) { console.error('adb: device \\'' + serial + '\\' not found'); process.exit(1); }
    if (args[2] === 'shell' && args[3] === 'getprop ro.serialno; getprop ro.build.version.release') console.log(known.join('\\n'));
    else if (args[2] === 'shell' && args[3] === '-T') { const child = require('node:child_process').spawn('/bin/sh', [], {env: process.env, stdio: 'inherit'}); child.on('exit', code => process.exit(code ?? 1)); }
    else if (args[2] === 'shell' && args[3].startsWith("'input'")) {}
    else if (args[2] === 'emu') process.exit(1);
  `,
  );
  await nodeBinary(
    bin,
    "input",
    `require('node:fs').appendFileSync(process.env.DEVICE_JOURNAL, JSON.stringify({tool: 'input', args: process.argv.slice(2)})+'\\n');`,
  );
  const sdk = join(home, "Android/Sdk");
  if (options.sdkEmulator) {
    await mkdir(join(sdk, "emulator"), { recursive: true });
    await nodeBinary(
      join(sdk, "emulator"),
      "emulator",
      `if (process.argv.includes('-list-avds')) console.log('Pixel_API_35');`,
    );
  }
  const env = { PATH: bin, DEVICE_JOURNAL: journal, DEVICE_LIST: list, DEVICE_PROPS: props };
  const manager = new DevicePlatform({
    platform: "linux",
    arch: options.arch ?? "x64",
    home,
    env,
  });
  onTestFinished(() => manager.close());
  const commands = async () =>
    (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z.object({ tool: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)),
      );
  return {
    manager,
    commands,
    devices: (text: string) => writeFile(list, text),
    props: (value: Record<string, [string, string]>) => writeFile(props, JSON.stringify(value)),
  };
}

const usbLine =
  "R58M123ABC             device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:3";
const tcpLine =
  "192.168.1.5:5555       device product:panther model:Pixel_7 device:panther transport_id:4";

it("a phone on USB and a device reached by adb connect are listed by model with their Android release", async () => {
  const f = await fixture();
  await f.devices(`${usbLine}\n${tcpLine}\n`);
  await f.props({ R58M123ABC: ["R58M123ABC", "14"], "192.168.1.5:5555": ["28161FDH2000AB", "15"] });
  expect(await f.manager.list()).toEqual([
    {
      id: "android:R58M123ABC",
      platform: "android",
      name: "SM G973F",
      state: "booted",
      serial: "R58M123ABC",
      runtime: "Android 14",
    },
    {
      id: "android:28161FDH2000AB",
      platform: "android",
      name: "Pixel 7",
      state: "booted",
      serial: "192.168.1.5:5555",
      runtime: "Android 15",
    },
  ]);
  expect(f.manager.diagnostics()).toEqual([]);
});

it("a tap on a network device goes over its own transport, and stops once that address is another device", async () => {
  const f = await fixture();
  await f.devices(`${tcpLine}\n`);
  await f.props({ "192.168.1.5:5555": ["28161FDH2000AB", "15"] });
  const [device] = await f.manager.list();
  if (!device) throw new Error("no device listed");
  await f.manager.input(device, { kind: "tap", x: 10, y: 20 });
  expect((await f.commands()).filter((entry) => entry.tool === "input")).toEqual([
    { tool: "input", args: ["tap", "10", "20"] },
  ]);
  expect(
    (await f.commands()).some(
      (entry) => entry.args[1] === "192.168.1.5:5555" && entry.args.includes("-T"),
    ),
  ).toBe(true);

  // The DHCP lease moved: another phone now answers on that address.
  await f.props({ "192.168.1.5:5555": ["OTHERPHONE01", "13"] });
  await expect(f.manager.screenshot(device)).rejects.toMatchObject({ code: "not_found" });
});

it("one phone on USB and over Wi-Fi at once is one device, and keeps its id when the cable comes out", async () => {
  const f = await fixture();
  const wifi = "adb-R58M123ABC-x1y2z3._adb-tls-connect._tcp device product:beyond1 model:SM_G973F";
  await f.devices(`${wifi}\n${usbLine}\n`);
  await f.props({
    R58M123ABC: ["R58M123ABC", "14"],
    "adb-R58M123ABC-x1y2z3._adb-tls-connect._tcp": ["R58M123ABC", "14"],
  });
  expect(await f.manager.list()).toMatchObject([
    { id: "android:R58M123ABC", serial: "R58M123ABC", state: "booted" },
  ]);
  await f.devices(`${wifi}\n`);
  expect(await f.manager.list()).toMatchObject([
    {
      id: "android:R58M123ABC",
      serial: "adb-R58M123ABC-x1y2z3._adb-tls-connect._tcp",
      state: "booted",
    },
  ]);
});

it("a phone that hasn't allowed USB debugging is listed as unauthorized and says how to allow it", async () => {
  const f = await fixture();
  await f.devices("0123456789ABCDEF       unauthorized usb:1-2 transport_id:5\n");
  const devices = await f.manager.list();
  expect(devices).toEqual([
    {
      id: "android:0123456789ABCDEF",
      platform: "android",
      name: "Android device",
      state: "unauthorized",
      serial: "0123456789ABCDEF",
    },
  ]);
  expect(f.manager.diagnostics()).toEqual([
    expect.objectContaining({
      code: "permission_denied",
      message: expect.stringContaining("allow USB debugging"),
      hint: expect.stringContaining("Allow USB debugging?"),
    }),
  ]);
  const [device] = devices as [Device];
  await expect(f.manager.input(device, { kind: "tap", x: 1, y: 1 })).rejects.toMatchObject({
    code: "permission_denied",
    hint: expect.stringContaining("Allow USB debugging?"),
  });
});

it("on Linux, a phone this user can't open over USB says how to add the udev rule", async () => {
  const f = await fixture();
  // Older adb can't read the serial without permission, and says so in its own words.
  await f.devices(
    "????????????           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:3-1 transport_id:7\n",
  );
  const devices = await f.manager.list();
  expect(devices).toMatchObject([
    { id: "android:usb-3-1", name: "Android device", state: "unauthorized" },
  ]);
  expect(f.manager.diagnostics()).toEqual([
    expect.objectContaining({
      code: "permission_denied",
      message: expect.stringContaining("can't open it over USB"),
      hint: expect.stringMatching(/udev.*plugdev/),
    }),
  ]);
  const [device] = devices as [Device];
  await expect(f.manager.screenshot(device)).rejects.toMatchObject({
    code: "permission_denied",
    hint: expect.stringContaining("android-udev-rules"),
  });
});

it("ace neither boots nor powers off a phone", async () => {
  const f = await fixture();
  await f.devices(`${usbLine}\n`);
  await f.props({ R58M123ABC: ["R58M123ABC", "14"] });
  const [device] = (await f.manager.list()) as [Device];
  await expect(f.manager.shutdown(device)).rejects.toMatchObject({ code: "not_supported" });
  await expect(f.manager.boot(device)).resolves.toBeUndefined();
  await expect(
    f.manager.configure(device, { location: { latitude: 1, longitude: 2 } }),
  ).rejects.toMatchObject({ code: "not_supported" });
  await f.devices("R58M123ABC             offline usb:1-1 transport_id:3\n");
  await expect(f.manager.boot(device)).rejects.toMatchObject({
    code: "not_booted",
    message: expect.stringContaining("offline"),
  });
  const powered = (await f.commands()).filter(
    (entry) => entry.args.includes("reboot") || entry.args.includes("emu"),
  );
  expect(powered).toEqual([]);
});

it("on Linux arm64 the distribution's adb runs phones, and the missing emulator is said once", async () => {
  const f = await fixture({ arch: "arm64" });
  await f.devices(`${usbLine}\n`);
  await f.props({ R58M123ABC: ["R58M123ABC", "14"] });
  expect(await f.manager.list()).toMatchObject([{ id: "android:R58M123ABC", state: "booted" }]);
  expect(f.manager.diagnostics()).toEqual([
    {
      code: "not_supported",
      message: "Android emulators aren't available on Linux arm64",
      hint: expect.stringContaining("phones on USB and devices on the network work here"),
    },
  ]);
});

it("an SDK with only the emulator lists its AVDs beside phones, through the adb on PATH", async () => {
  const f = await fixture({ sdkEmulator: true });
  await f.devices(`${usbLine}\n`);
  await f.props({ R58M123ABC: ["R58M123ABC", "14"] });
  expect(await f.manager.list()).toMatchObject([
    { id: "android:Pixel_API_35", state: "shutdown" },
    { id: "android:R58M123ABC", state: "booted" },
  ]);
  expect(f.manager.diagnostics()).toEqual([]);
});

it("with no adb anywhere, Linux says which package to install", async () => {
  for (const arch of ["x64", "arm64"]) {
    const home = await mkdtemp(join(tmpdir(), "ace-android-none-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const manager = new DevicePlatform({ platform: "linux", arch, home, env: { PATH: "" } });
    onTestFinished(() => manager.close());
    await expect(manager.list()).rejects.toMatchObject({
      code: "sdk_missing",
      hint: expect.stringContaining("sudo apt install adb"),
    });
  }
});
