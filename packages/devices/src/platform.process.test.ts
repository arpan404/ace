import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { DevicePlatform, type Device } from "./index.ts";

function shutdownClock(ms: number, run: () => void) {
  if (ms === 30000) {
    queueMicrotask(run);
    return () => {};
  }
  return () => {};
}

const udid = "11111111-1111-4111-8111-111111111111";
async function fixture(platform = "linux") {
  const home = await mkdtemp(join(tmpdir(), "ace-device-platform-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sdk = join(home, "Library/Android/sdk");
  const bin = join(home, "bin");
  await Promise.all([
    mkdir(join(sdk, "platform-tools"), { recursive: true }),
    mkdir(join(sdk, "emulator"), { recursive: true }),
    mkdir(bin),
  ]);
  const journal = join(home, "commands.jsonl");
  await writeFile(journal, "");
  const state = join(home, "state");
  await writeFile(state, "shutdown");
  const record = `const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.DEVICE_JOURNAL, JSON.stringify({tool: require('node:path').basename(process.argv[1]), args})+'\\n');`;
  await nodeBinary(
    join(sdk, "platform-tools"),
    "adb",
    `${record}
    const serial = 'emulator-5554';
    const connection = fs.readFileSync(process.env.DEVICE_STATE,'utf8');
    if (args[0] === 'devices') { console.log('List of devices attached\\n' + (connection==='shutdown' ? '' : serial+' '+(connection==='booted'?'device':connection)+' product:sdk model:pixel')); }
    else if (args.includes('wait-for-device')) { fs.writeFileSync(process.env.DEVICE_STATE,'attached'); }
    else if (args.some(arg=>arg.includes('sys.boot_completed'))) { fs.writeFileSync(process.env.DEVICE_STATE,'booted'); }
    else if(args.includes('install') && connection!=='booted') { process.exit(2); }
    else if (args.includes('avd')) console.log('Pixel_API_35\\nOK');
    else if (args.includes('kill')) fs.writeFileSync(process.env.DEVICE_STATE,'shutdown');
    else if (args.includes('cat')) console.log(fs.readFileSync(process.env.DEVICE_TREE,'utf8'));
    else if (args.some(arg => arg.includes('resolve-activity'))) console.log('dev.example/.MainActivity');
    else if (args.some(arg => arg.includes("'wm' 'size'"))) console.log('Physical size: 1080x2400'+(process.env.DEVICE_OVERRIDE==='1'?'\\nOverride size: 720x1600':''));
    else if (args.some(arg => arg.includes("'settings' 'get'"))) console.log('0');
    else if(args[2]==='shell' && args[3]==='-T') { const child=require('node:child_process').spawn('/bin/sh',[],{env:process.env,stdio:'inherit'}); child.on('exit',code=>process.exit(code??1)); }
    else if(args[2]==='shell' && (args[3].startsWith("'input'") || args[3].startsWith("'am'") || args[3].startsWith('input ') || args[3].startsWith('am '))) { require('node:child_process').execFileSync('/bin/sh', ['-c', args[3]], {env:process.env,stdio:'inherit'}); }
    else if (args.includes('logcat')) { process.stdout.write('x'.repeat(32768)+'\\n'); }
  `,
  );
  await nodeBinary(
    join(sdk, "emulator"),
    "emulator",
    `${record}
    if (args.includes('-list-avds')) console.log('Pixel_API_35');
    else { process.stdin.resume(); }
  `,
  );
  await nodeBinary(
    bin,
    "xcode-select",
    `${record} console.log('/Applications/Xcode.app/Contents/Developer');`,
  );
  await nodeBinary(bin, "open", record);
  await nodeBinary(bin, "input", record);
  await nodeBinary(bin, "am", record);
  await nodeBinary(
    bin,
    "xcrun",
    `${record}
    if (args.includes('list')) console.log(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-18-0':[{udid:'${udid}',name:'iPhone',state:fs.readFileSync(process.env.DEVICE_STATE,'utf8')==='booted'?'Booted':'Shutdown',isAvailable:true}]}}));
    else if(args.includes('boot')) fs.writeFileSync(process.env.DEVICE_STATE,'booted');
    else if(args.includes('shutdown')) fs.writeFileSync(process.env.DEVICE_STATE,'shutdown');
  `,
  );
  const tree = join(home, "ui.xml");
  await writeFile(
    tree,
    '<hierarchy rotation="0"><node index="0" text="Launch" resource-id="dev.example:id/launch" class="android.widget.Button" package="dev.example" content-desc="" clickable="true" enabled="true" bounds="[10,20][110,80]" /></hierarchy>',
  );
  const env = { PATH: bin, DEVICE_JOURNAL: journal, DEVICE_STATE: state, DEVICE_TREE: tree };
  const manager = new DevicePlatform({ platform, home, env, after: shutdownClock });
  onTestFinished(() => manager.close());
  const commands = async () =>
    (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z.object({ tool: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)),
      );
  return { home, sdk, bin, journal, state, tree, env, manager, commands };
}
function android(): Device {
  return {
    id: "android:Pixel_API_35",
    platform: "android",
    name: "Pixel_API_35",
    state: "shutdown",
  };
}
function ios(): Device {
  return { id: `ios:${udid}`, platform: "ios", name: "iPhone", state: "shutdown" };
}

it("concurrent Android taps share a transport and reach the emulator in order", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await f.manager.list();
  await Promise.all(
    Array.from({ length: 10 }, (_, x) => f.manager.input(android(), { kind: "tap", x, y: 20 })),
  );
  const commands = await f.commands();
  expect(commands.filter((entry) => entry.tool === "input").map((entry) => entry.args)).toEqual(
    Array.from({ length: 10 }, (_, x) => ["tap", String(x), "20"]),
  );
  expect(
    commands.filter((entry) => entry.tool === "adb" && entry.args.includes("-T")),
  ).toHaveLength(1);
});

it("discovers an SDK outside PATH and keeps an AVD identity through boot and shutdown", async () => {
  const f = await fixture();
  expect(await f.manager.list()).toEqual([android()]);
  await f.manager.boot(android());
  await f.manager.install(android(), join(f.home, "Ready.apk"));
  expect(await readFile(f.state, "utf8")).toBe("booted");
  expect(await f.manager.list()).toEqual([
    { ...android(), state: "booted", serial: "emulator-5554" },
  ]);
  await f.manager.shutdown(android());
  expect(await f.manager.list()).toEqual([android()]);
});
it("uses ANDROID_SDK_ROOT when the configured ANDROID_HOME lacks required tools", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: join(f.home, "other-home"),
    env: { ...f.env, ANDROID_HOME: join(f.home, "missing"), ANDROID_SDK_ROOT: f.sdk },
  });
  onTestFinished(() => manager.close());
  expect(await manager.list()).toEqual([android()]);
});
it("reports a missing SDK with an actionable typed error", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: join(f.home, "empty"),
    env: { PATH: "" },
  });
  onTestFinished(() => manager.close());
  await expect(manager.list()).rejects.toMatchObject({
    code: "sdk_missing",
    hint: expect.stringContaining("ANDROID_HOME"),
  });
});
it("reuses simulator discovery and boot then installs and launches a Simulator app", async () => {
  const f = await fixture("darwin");
  expect(await f.manager.list()).toContainEqual({
    ...ios(),
    runtime: "iOS 18.0",
  });
  await f.manager.boot(ios());
  await f.manager.install(ios(), join(f.home, "Example.app"));
  await f.manager.openApp(ios(), "dev.example");
  await f.manager.openUrl(ios(), "example://inbox");
  await f.manager.configure(ios(), {
    appearance: "dark",
    location: { latitude: 41, longitude: -87 },
  });
  const commands = await f.commands();
  expect(commands).toContainEqual({
    tool: "open",
    args: ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid],
  });
  expect(commands).toContainEqual({
    tool: "xcrun",
    args: ["simctl", "install", udid, join(f.home, "Example.app")],
  });
  expect(commands).toContainEqual({
    tool: "xcrun",
    args: ["simctl", "launch", udid, "dev.example"],
  });
  expect(commands).toContainEqual({
    tool: "xcrun",
    args: ["simctl", "location", udid, "set", "41,-87"],
  });
});
it("maps Android gestures, keys and text to the selected emulator with shell-safe quoting", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await f.manager.install(android(), join(f.home, "Example.apk"));
  await f.manager.input(android(), { kind: "tap", x: 15, y: 25 });
  await f.manager.input(android(), { kind: "longPress", x: 10, y: 20, durationMs: 900 });
  await f.manager.input(android(), { kind: "swipe", x: 1, y: 2, toX: 3, toY: 4, durationMs: 350 });
  await f.manager.input(android(), { kind: "key", key: "back" });
  await f.manager.input(android(), { kind: "type", text: "a';$(echo unsafe) & b" });
  await f.manager.openUrl(android(), "example://inbox?q=';touch%20bad&x=1");
  const commands = await f.commands();
  expect(commands).toContainEqual({
    tool: "adb",
    args: ["-s", "emulator-5554", "install", "-r", join(f.home, "Example.apk")],
  });
  for (const args of [
    ["tap", "15", "25"],
    ["swipe", "10", "20", "10", "20", "900"],
    ["swipe", "1", "2", "3", "4", "350"],
    ["keyevent", "4"],
    ["text", "a';$(echo%sunsafe)%s&%sb"],
  ])
    expect(commands).toContainEqual({ tool: "input", args });
  expect(
    commands.filter((command) => command.tool === "adb" && command.args.includes("-T")),
  ).toHaveLength(1);
  expect(commands).toContainEqual({
    tool: "adb",
    args: [
      "-s",
      "emulator-5554",
      "shell",
      "'am' 'start' '-a' 'android.intent.action.VIEW' '-d' 'example://inbox?q='\\'';touch%20bad&x=1'",
    ],
  });
});
it("rejects adb text it cannot reproduce instead of changing it", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await expect(
    f.manager.input(android(), { kind: "type", text: "literal %s" }),
  ).rejects.toMatchObject({ code: "not_supported" });
  await expect(f.manager.input(android(), { kind: "type", text: "مرحبا" })).rejects.toMatchObject({
    code: "not_supported",
  });
  expect(await f.commands()).toEqual([]);
});
it("refreshes Android semantic targets and refuses a stale node after its identity changes", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const found = await f.manager.uiFind(android(), { query: { name: "launch" } });
  const ref = found.nodes[0]?.ref;
  expect(ref).toBeDefined();
  await f.manager.uiAct(android(), { ref, action: "press" });
  expect(await f.commands()).toContainEqual({
    tool: "input",
    args: ["tap", "60", "50"],
  });
  await writeFile(f.journal, "");
  await writeFile(f.tree, (await readFile(f.tree, "utf8")).replaceAll("Launch", "Delete"));
  await expect(f.manager.uiAct(android(), { ref, action: "press" })).rejects.toMatchObject({
    code: "stale_ref",
  });
  expect((await f.commands()).filter((entry) => JSON.stringify(entry).includes("input"))).toEqual(
    [],
  );
});
it("bounds Android trees and finds matching descendants without losing truncation", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const children = Array.from(
    { length: 10 },
    (_, index) =>
      `<node text="Button ${index}" class="android.widget.Button" clickable="true" enabled="true" bounds="[0,0][10,10]"/>`,
  ).join("");
  await writeFile(
    f.tree,
    `<hierarchy><node text="Root" class="android.widget.FrameLayout" bounds="[0,0][100,100]">${children}</node></hierarchy>`,
  );
  const tree = await f.manager.uiTree(android(), { maxNodes: 3, maxDepth: 2 });
  expect(tree.truncated).toBe(true);
  expect(tree.nodes[0]?.children).toHaveLength(2);
  const found = await f.manager.uiFind(android(), { query: { role: "Button" }, limit: 2 });
  expect(found.nodes.map((node) => node.name)).toEqual(["Button 0", "Button 1"]);
  expect(found.truncated).toBe(true);
});
it("reports missing idb for gestures and unsupported Simulator packages with fix hints", async () => {
  const f = await fixture("darwin");
  await expect(
    f.manager.input(ios(), { kind: "longPress", x: 1, y: 2, durationMs: 700 }),
  ).rejects.toMatchObject({ code: "tool_missing", hint: expect.stringContaining("idb") });
  await expect(f.manager.install(ios(), join(f.home, "Example.ipa"))).rejects.toMatchObject({
    code: "not_supported",
    hint: expect.stringContaining("Simulator"),
  });
});

for (const platform of ["linux", "darwin"])
  it(`${platform} rejects unsupported locale before applying appearance or location`, async () => {
    const f = await fixture(platform);
    await f.manager.list();
    const before = await f.commands();
    await expect(
      f.manager.configure(platform === "darwin" ? ios() : android(), {
        locale: "fr-FR",
        appearance: "dark",
        location: { latitude: 41, longitude: -87 },
      }),
    ).rejects.toMatchObject({ code: "not_supported", hint: expect.stringContaining("Settings") });
    expect(await f.commands()).toEqual(before);
  });

it("keeps previously identified emulators offline or unauthorized and refuses their input", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await f.manager.list();
  await writeFile(f.state, "offline");
  expect(await f.manager.list()).toEqual([
    { ...android(), state: "offline", serial: "emulator-5554" },
  ]);
  await expect(f.manager.input(android(), { kind: "tap", x: 0, y: 0 })).rejects.toMatchObject({
    code: "not_booted",
  });
  await writeFile(f.state, "unauthorized");
  await expect(f.manager.input(android(), { kind: "tap", x: 0, y: 0 })).rejects.toMatchObject({
    code: "permission_denied",
  });
});
it("reports a command-line-tools-only Xcode selection instead of treating it as a Simulator SDK", async () => {
  const f = await fixture("darwin");
  await nodeBinary(f.bin, "xcode-select", "console.log('/Library/Developer/CommandLineTools');");
  await rm(f.sdk, { recursive: true });
  await expect(f.manager.list()).rejects.toMatchObject({
    code: "sdk_missing",
    hint: expect.stringContaining("Xcode"),
  });
});
it("treats metacharacters in URLs and text as input rather than executing a remote shell command", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const marker = join(f.home, "injected");
  await f.manager.openUrl(android(), `example://inbox; /usr/bin/touch ${marker}`);
  await f.manager.input(android(), { kind: "type", text: "one & two; three" });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.commands()).toContainEqual({
    tool: "am",
    args: [
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `example://inbox; /usr/bin/touch ${marker}`,
    ],
  });
  expect(await f.commands()).toContainEqual({
    tool: "input",
    args: ["text", "one%s&%stwo;%sthree"],
  });
});
it("uses integer target centers for odd Android bounds", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await writeFile(
    f.tree,
    '<hierarchy><node text="Odd" class="android.widget.Button" clickable="true" bounds="[0,0][3,5]" /></hierarchy>',
  );
  const tree = await f.manager.uiTree(android(), {});
  await f.manager.uiAct(android(), { ref: tree.nodes[0]?.ref, action: "press" });
  expect(await f.commands()).toContainEqual({ tool: "input", args: ["tap", "1", "2"] });
});
it("passes gesture duration to idb in seconds and identifies the chosen Simulator", async () => {
  const f = await fixture("darwin");
  await nodeBinary(
    f.bin,
    "idb",
    "require('node:fs').appendFileSync(process.env.DEVICE_JOURNAL, JSON.stringify({tool:'idb',args:process.argv.slice(2)})+'\\n');",
  );
  await f.manager.input(ios(), { kind: "type", text: "hello 👋" });
  expect(await f.commands()).toContainEqual({
    tool: "idb",
    args: ["ui", "text", "hello 👋", "--udid", udid],
  });
  await f.manager.input(ios(), { kind: "key", key: "enter" });
  await f.manager.input(ios(), { kind: "key", key: "home" });
  await f.manager.input(ios(), { kind: "key", key: "power" });
  for (const args of [
    ["ui", "key", "40"],
    ["ui", "button", "HOME"],
    ["ui", "button", "LOCK"],
  ])
    expect(await f.commands()).toContainEqual({ tool: "idb", args: [...args, "--udid", udid] });
  await f.manager.input(ios(), { kind: "longPress", x: 20, y: 40, durationMs: 750 });
  await f.manager.input(ios(), { kind: "swipe", x: 20, y: 40, toX: 80, toY: 60, durationMs: 1500 });
  expect(await f.commands()).toContainEqual({
    tool: "idb",
    args: ["ui", "tap", "20", "40", "--duration", "0.75", "--udid", udid],
  });
  expect(await f.commands()).toContainEqual({
    tool: "idb",
    args: ["ui", "swipe", "20", "40", "80", "60", "--duration", "1.5", "--udid", udid],
  });
});
it("rotates Android with a window-manager rotation lock", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await f.manager.input(android(), { kind: "key", key: "rotate" });
  expect(await f.commands()).toContainEqual({
    tool: "adb",
    args: ["-s", "emulator-5554", "shell", "'wm' 'user-rotation' 'lock' '1'"],
  });
});
it("rejects malformed or entity-expanding Android UI XML before acting", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  await writeFile(f.tree, '<!DOCTYPE hierarchy [<!ENTITY injected "expanded">]><hierarchy/>');
  await expect(f.manager.uiTree(android(), {})).rejects.toMatchObject({ code: "limit" });
  await writeFile(f.tree, '<hierarchy><node text="Unclosed" bounds="[0,0][10,10]"></hierarchy>');
  await expect(f.manager.uiTree(android(), {})).rejects.toMatchObject({ code: "invalid_data" });
});
it("revoked ownership during an Android UI read prevents the later tap", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const tree = await f.manager.uiTree(android(), {});
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: async (command, args, options) => {
      const { probeOutput } = await import("@ace/provider-kit/process");
      const result = await probeOutput(command, args, options);
      if (args.includes("cat")) {
        reading.resolve();
        await resume.promise;
      }
      return result;
    },
  });
  onTestFinished(() => manager.close());
  let authorized = true;
  const action = manager.uiAct(android(), { ref: tree.nodes[0]?.ref, action: "press" }, () => {
    if (!authorized) throw new Error("Controller ownership changed");
  });
  const result = expect(action).rejects.toThrow("Controller ownership changed");
  await reading.promise;
  authorized = false;
  resume.resolve();
  await result;
  expect(
    (await f.commands()).some(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "tool" in command &&
        command.tool === "input",
    ),
  ).toBe(false);
});

it("reads Android native display dimensions and prefers an explicit display override", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  expect(await f.manager.captureDimensions(android())).toEqual({ width: 1080, height: 2400 });
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: { ...f.env, DEVICE_OVERRIDE: "1" },
  });
  onTestFinished(() => manager.close());
  expect(await manager.captureDimensions(android())).toEqual({ width: 720, height: 1600 });
});
for (const operation of ["install", "openApp", "boot"] as const) {
  it(`Android lease expiry during ${operation} lookup prevents its native dispatch`, async () => {
    const f = await fixture();
    if (operation !== "boot") await writeFile(f.state, "booted");
    const lookup = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let blocked = false;
    const manager = new DevicePlatform({
      platform: "linux",
      home: f.home,
      env: f.env,
      after: shutdownClock,
      probe: async (command, args, options) => {
        const { probeOutput } = await import("@ace/provider-kit/process");
        const result = await probeOutput(command, args, options);
        if (
          !blocked &&
          (operation === "boot"
            ? args[0] === "devices"
            : args.some((arg) => arg.includes("resolve-activity")) ||
              (operation === "install" && args.includes("avd")))
        ) {
          blocked = true;
          lookup.resolve();
          await resume.promise;
        }
        return result;
      },
    });
    onTestFinished(() => manager.close());
    let authorized = true;
    const guard = () => {
      if (!authorized) throw new Error("Lifecycle lease expired");
    };
    const pending =
      operation === "install"
        ? manager.install(android(), join(f.home, "Example.apk"), guard)
        : operation === "openApp"
          ? manager.openApp(android(), "dev.example", guard)
          : manager.boot(android(), guard);
    const rejected = expect(pending).rejects.toThrow("Lifecycle lease expired");
    await lookup.promise;
    authorized = false;
    resume.resolve();
    await rejected;
    const commands = await f.commands();
    expect(
      commands.some(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          "tool" in command &&
          command.tool === "am",
      ),
    ).toBe(false);
    expect(commands).not.toContainEqual({
      tool: "adb",
      args: ["-s", "emulator-5554", "install", "-r", join(f.home, "Example.apk")],
    });
    expect(commands).not.toContainEqual({
      tool: "emulator",
      args: ["-avd", "Pixel_API_35", "-port", "5554"],
    });
  });
}
for (const operation of ["install", "openApp", "boot"] as const) {
  it(`Simulator lease expiry during ${operation} discovery prevents simctl mutation`, async () => {
    const f = await fixture("darwin");
    const lookup = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let blocked = false;
    const manager = new DevicePlatform({
      platform: "darwin",
      home: f.home,
      env: f.env,
      after: shutdownClock,
      probe: async (command, args, options) => {
        const { probeOutput } = await import("@ace/provider-kit/process");
        const result = await probeOutput(command, args, options);
        if (!blocked && args[0] === "-p") {
          blocked = true;
          lookup.resolve();
          await resume.promise;
        }
        return result;
      },
    });
    onTestFinished(() => manager.close());
    let authorized = true;
    const guard = () => {
      if (!authorized) throw new Error("Simulator lease expired");
    };
    const pending =
      operation === "install"
        ? manager.install(ios(), join(f.home, "Example.app"), guard)
        : operation === "openApp"
          ? manager.openApp(ios(), "dev.example", guard)
          : manager.boot(ios(), guard);
    const rejected = expect(pending).rejects.toThrow("Simulator lease expired");
    await lookup.promise;
    authorized = false;
    resume.resolve();
    await rejected;
    const commands = await f.commands();
    expect(commands).not.toContainEqual({
      tool: "xcrun",
      args: ["simctl", "install", udid, join(f.home, "Example.app")],
    });
    expect(commands).not.toContainEqual({
      tool: "xcrun",
      args: ["simctl", "launch", udid, "dev.example"],
    });
    expect(commands).not.toContainEqual({ tool: "xcrun", args: ["simctl", "boot", udid] });
    expect(commands).not.toContainEqual({
      tool: "open",
      args: ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid],
    });
  });
}

it("concurrent Android UI reads retain their own snapshot and remove temporary guest files", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  let guestSnapshot = "";
  let dumps = 0;
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(command, args, options) {
      const line = args.join(" ");
      if (line.includes("'uiautomator' 'dump'")) {
        guestSnapshot = `<hierarchy><node text="Snapshot ${++dumps}" class="android.widget.Button" clickable="true" enabled="true" bounds="[0,0][10,10]" /></hierarchy>`;
        if (dumps === 1) {
          reading.resolve();
          await resume.promise;
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("cat")) return { code: 0, stdout: guestSnapshot, stderr: "" };
      if (line.includes("'rm' '-f'")) {
        guestSnapshot = "";
        return { code: 0, stdout: "", stderr: "" };
      }
      const { probeOutput } = await import("@ace/provider-kit/process");
      return probeOutput(command, args, options);
    },
  });
  onTestFinished(() => manager.close());
  const first = manager.uiTree(android(), {});
  await reading.promise;
  const second = manager.uiTree(android(), {});
  resume.resolve();
  const trees = await Promise.all([first, second]);
  expect(trees.map((tree) => tree.nodes[0]?.name)).toEqual(["Snapshot 1", "Snapshot 2"]);
  expect(guestSnapshot).toBe("");
});

it("a booted emulator is named from its system property when the emulator console is unreachable", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel", stderr: "", code: 0 };
      if (args[0] === "devices")
        return {
          stdout: "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name")) return { stdout: "Pixel\n", stderr: "", code: 0 };
      if (args.includes("ro.kernel.qemu.avd_name")) return { stdout: "", stderr: "", code: 0 };
      if (args.includes("avd")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => manager.close());
  expect(await manager.list()).toEqual([
    {
      id: "android:Pixel",
      platform: "android",
      name: "Pixel",
      state: "booted",
      serial: "emulator-5554",
    },
  ]);
});

it("an emulator whose name cannot be read is still listed and does not hide other devices", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return { stdout: "Tablet", stderr: "", code: 0 };
      if (args[0] === "devices")
        return {
          stdout: "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      return { stdout: "", stderr: "", code: 0 };
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => manager.close());
  const devices = await manager.list();
  expect(devices).toHaveLength(2);
  expect(devices).toContainEqual({
    id: "android:Tablet",
    platform: "android",
    name: "Tablet",
    state: "shutdown",
  });
  expect(devices).toContainEqual({
    id: "android:emulator-5554",
    platform: "android",
    name: "Android emulator",
    state: "booted",
    serial: "emulator-5554",
  });
  // A serial is a display fallback, not an AVD identity that can authorize capture or input.
  await expect(
    manager.captureTransport({
      id: "android:emulator-5554",
      platform: "android",
      name: "Android emulator",
      state: "booted",
      serial: "emulator-5554",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
});

for (const source of ["kernel", "console"] as const)
  it(`rejected emulator property probes fall back to the ${source} name without hiding devices`, async () => {
    const f = await fixture();
    const manager = new DevicePlatform({
      platform: "linux",
      home: f.home,
      env: f.env,
      after: shutdownClock,
      probe: async (_command, args) => {
        if (args.includes("-list-avds")) return { stdout: "Pixel\nTablet", stderr: "", code: 0 };
        if (args[0] === "devices")
          return {
            stdout: "List of devices attached\nemulator-5554 device product:sdk model:pixel",
            stderr: "",
            code: 0,
          };
        if (
          args.includes("ro.boot.qemu.avd_name") ||
          (source === "console" && args.includes("ro.kernel.qemu.avd_name"))
        )
          return { stdout: "", stderr: "Property lookup failed", code: 1 };
        if (args.includes("ro.kernel.qemu.avd_name") || args.includes("avd"))
          return { stdout: "Pixel\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    onTestFinished(() => manager.close());
    expect(await manager.list()).toEqual([
      {
        id: "android:Pixel",
        platform: "android",
        name: "Pixel",
        state: "booted",
        serial: "emulator-5554",
      },
      { id: "android:Tablet", platform: "android", name: "Tablet", state: "shutdown" },
    ]);
  });

it("shutting down an emulator waits until adb no longer lists it", async () => {
  const f = await fixture();
  let disconnected = false;
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args.includes("wait-for-any-disconnect")) {
        disconnected = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "devices")
        return {
          stdout: disconnected
            ? "List of devices attached\n"
            : "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name"))
        return { stdout: disconnected ? "" : "Pixel_API_35\n", stderr: "", code: 0 };
      if (args.includes("ro.kernel.qemu.avd_name")) return { stdout: "", stderr: "", code: 0 };
      if (args.includes("avd")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => manager.close());
  const listed = await manager.list();
  expect(listed).toEqual([{ ...android(), state: "booted", serial: "emulator-5554" }]);
  await manager.shutdown(listed[0] ?? android());
  expect(await manager.list()).toEqual([android()]);
});

it("an emulator the console cannot stop is powered off through adb", async () => {
  const f = await fixture();
  let poweredOff = false;
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args.includes("wait-for-any-disconnect")) {
        if (!poweredOff) throw new Error("Probe timed out");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args.includes("reboot")) {
        poweredOff = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "devices")
        return {
          stdout: poweredOff
            ? "List of devices attached\n"
            : "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name"))
        return { stdout: poweredOff ? "" : "Pixel_API_35\n", stderr: "", code: 0 };
      if (args.includes("ro.kernel.qemu.avd_name")) return { stdout: "", stderr: "", code: 0 };
      if (args.includes("avd")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => manager.close());
  const listed = await manager.list();
  expect(listed).toEqual([{ ...android(), state: "booted", serial: "emulator-5554" }]);
  await manager.shutdown(listed[0] ?? android());
  expect(await manager.list()).toEqual([android()]);
});

it("an emulator that never disconnects fails shutdown with a clear error", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: (async (_command: string, args: readonly string[]) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args.includes("wait-for-any-disconnect")) throw new Error("Probe timed out");
      if (args[0] === "devices")
        return {
          stdout: "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name"))
        return { stdout: "Pixel_API_35\n", stderr: "", code: 0 };
      if (args.includes("ro.kernel.qemu.avd_name")) return { stdout: "", stderr: "", code: 0 };
      if (args.includes("avd")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as typeof import("@ace/provider-kit/process").probeOutput,
  });
  onTestFinished(() => manager.close());
  const listed = await manager.list();
  expect(listed).toEqual([{ ...android(), state: "booted", serial: "emulator-5554" }]);
  await expect(manager.shutdown(listed[0] ?? android())).rejects.toThrow(
    "Emulator did not shut down",
  );
});

async function waitingShutdown() {
  const f = await fixture();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let name = "Pixel_API_35";
  let poweredOff = false;
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    probe: async (_command, args) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args[0] === "devices")
        return {
          stdout: "List of devices attached\nemulator-5554 device product:sdk model:pixel",
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name")) return { stdout: name, stderr: "", code: 0 };
      if (args.includes("wait-for-any-disconnect")) {
        waiting.resolve();
        await resume.promise;
        throw new Error("Probe timed out");
      }
      if (args.includes("reboot")) poweredOff = true;
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  onTestFinished(() => manager.close());
  onTestFinished(() => resume.resolve());
  return {
    manager,
    waiting: waiting.promise,
    resume: () => resume.resolve(),
    replaceTransport: () => {
      name = "Another_AVD";
    },
    poweredOff: () => poweredOff,
  };
}

it("control transfer during the shutdown disconnect wait fences the fallback power-off", async () => {
  const f = await waitingShutdown();
  let authorized = true;
  const pending = f.manager.shutdown(android(), () => {
    if (!authorized) throw new Error("Controller ownership changed");
  });
  const rejected = expect(pending).rejects.toThrow("Controller ownership changed");
  await f.waiting;
  authorized = false;
  f.resume();
  await rejected;
  expect(f.poweredOff()).toBe(false);
});

it("a reused emulator serial during shutdown never powers off the replacement AVD", async () => {
  const f = await waitingShutdown();
  const pending = f.manager.shutdown(android());
  const rejected = expect(pending).rejects.toMatchObject({ code: "not_found" });
  await f.waiting;
  f.replaceTransport();
  f.resume();
  await rejected;
  expect(f.poweredOff()).toBe(false);
});

it("control transfer while the console kill is pending preserves the owned emulator process", async () => {
  const f = await fixture();
  let running = false;
  let authorized = true;
  const processes: SupervisedProcess[] = [];
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    spawn: (options) => {
      const process = spawnSupervised(options);
      processes.push(process);
      return process;
    },
    probe: async (_command, args) => {
      if (args.includes("-list-avds")) return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args[0] === "devices")
        return {
          stdout:
            "List of devices attached\n" +
            (running ? "emulator-5554 device product:sdk model:pixel" : ""),
          stderr: "",
          code: 0,
        };
      if (args.includes("ro.boot.qemu.avd_name"))
        return { stdout: "Pixel_API_35", stderr: "", code: 0 };
      if (args.some((arg) => arg.includes("sys.boot_completed"))) running = true;
      if (args.includes("kill")) authorized = false;
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  onTestFinished(() => manager.close());
  await manager.boot(android());
  await expect(
    manager.shutdown(android(), () => {
      if (!authorized) throw new Error("Controller ownership changed");
    }),
  ).rejects.toThrow("Controller ownership changed");
  const child = processes[0];
  expect(child?.signal.aborted).toBe(false);
  const pid = child?.pid;
  if (!pid) throw new Error("Emulator process missing");
  expect(() => process.kill(pid, 0)).not.toThrow();
});

it("Android UI read queues reject excess work without retaining extra native operations", async () => {
  const f = await fixture();
  await writeFile(f.state, "booted");
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(command, args, options) {
      if (args.join(" ").includes("'uiautomator' 'dump'")) {
        reading.resolve();
        await resume.promise;
      }
      const { probeOutput } = await import("@ace/provider-kit/process");
      return probeOutput(command, args, options);
    },
  });
  onTestFinished(() => manager.close());
  const pending = Array.from({ length: 32 }, () => manager.uiTree(android(), {}));
  await reading.promise;
  await expect(manager.uiTree(android(), {})).rejects.toMatchObject({ code: "busy" });
  resume.resolve();
  expect(await Promise.all(pending)).toHaveLength(32);
  expect((await manager.uiTree(android(), {})).nodes[0]?.name).toBe("Launch");
});

it("device commands queue behind the concurrency cap and every inventory reader finishes", async () => {
  const f = await fixture();
  const saturated = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(_command, args) {
      if (++active === 8) saturated.resolve();
      await release.promise;
      active--;
      return {
        code: 0,
        stderr: "",
        stdout: args.includes("-list-avds") ? "Pixel" : "List of devices attached\n",
      };
    },
  });
  onTestFinished(() => manager.close());
  const requests = Array.from({ length: 12 }, () => manager.list());
  const completed = Promise.all(requests);
  void completed.catch(() => {});
  await saturated.promise;
  release.resolve();
  expect((await completed).map((devices) => devices[0]?.name)).toEqual(Array(12).fill("Pixel"));
});
for (const platform of ["linux", "darwin"])
  it(`a six-minute ${platform} installation fits its command timeout`, async () => {
    const f = await fixture(platform);
    await writeFile(f.state, "booted");
    const manager = new DevicePlatform({
      platform,
      home: f.home,
      env: f.env,
      after: shutdownClock,
      async probe(command, args, options) {
        if (args.includes("install") && (options?.timeoutMs ?? 0) < 360000)
          throw new Error("Probe timed out");
        const { probeOutput } = await import("@ace/provider-kit/process");
        return probeOutput(command, args, options);
      },
    });
    onTestFinished(() => manager.close());
    await manager.install(
      platform === "darwin" ? ios() : android(),
      join(f.home, platform === "darwin" ? "Example.app" : "Example.apk"),
    );
    expect(await f.commands()).toContainEqual({
      tool: platform === "darwin" ? "xcrun" : "adb",
      args:
        platform === "darwin"
          ? ["simctl", "install", udid, join(f.home, "Example.app")]
          : ["-s", "emulator-5554", "install", "-r", join(f.home, "Example.apk")],
    });
  });
it("inventory reuses emulator names until their transport disconnects", async () => {
  const f = await fixture();
  let connected = true;
  let readable = true;
  let name = "Pixel";
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(_command, args, options) {
      if (args.includes("-list-avds")) return { code: 0, stderr: "", stdout: "Pixel\nTablet" };
      if (args[0] === "devices")
        return {
          code: 0,
          stderr: "",
          stdout: connected
            ? "List of devices attached\nemulator-5554 device"
            : "List of devices attached\n",
        };
      if (!readable || (options?.timeoutMs ?? Infinity) > 5000) throw new Error("Probe timed out");
      return { code: 0, stderr: "", stdout: name };
    },
  });
  onTestFinished(() => manager.close());
  expect((await manager.list()).find((device) => device.serial)?.name).toBe("Pixel");
  readable = false;
  expect((await manager.list()).find((device) => device.serial)?.name).toBe("Pixel");
  connected = false;
  await manager.list();
  connected = true;
  readable = true;
  name = "Tablet";
  expect((await manager.list()).find((device) => device.serial)?.name).toBe("Tablet");
});
it("an owned emulator that goes offline after boot stays visible as offline", async () => {
  const f = await fixture();
  await f.manager.boot(android());
  await f.manager.list();
  await writeFile(f.state, "offline");
  expect(await f.manager.list()).toContainEqual(
    expect.objectContaining({
      id: "android:Pixel_API_35",
      state: "offline",
    }),
  );
});
it("duplicate Android transports report a device issue without hiding the inventory", async () => {
  const f = await fixture();
  const manager = new DevicePlatform({
    platform: "linux",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(_command, args) {
      return {
        code: 0,
        stderr: "",
        stdout: args.includes("-list-avds")
          ? "Pixel\nTablet"
          : args[0] === "devices"
            ? "List of devices attached\nemulator-5554 device\nemulator-5556 device"
            : "Pixel",
      };
    },
  });
  onTestFinished(() => manager.close());
  expect((await manager.list()).map((device) => [device.name, device.state])).toEqual([
    ["Pixel", "offline"],
    ["Tablet", "shutdown"],
  ]);
  expect(manager.diagnostics()).toContainEqual(
    expect.objectContaining({ hint: expect.stringContaining("duplicate") }),
  );
});
it("iOS logs use an info filter and follow the last launched app process", async () => {
  const f = await fixture("darwin");
  const manager = new DevicePlatform({
    platform: "darwin",
    home: f.home,
    env: f.env,
    after: shutdownClock,
    async probe(command, args, options) {
      if (args.includes("launch")) return { code: 0, stderr: "", stdout: "dev.example: 1234\n" };
      const { probeOutput } = await import("@ace/provider-kit/process");
      return probeOutput(command, args, options);
    },
  });
  onTestFinished(() => manager.close());
  await manager.openApp(ios(), "dev.example");
  const spec = await manager.logs(ios());
  expect(spec.args.slice(-4)).toEqual([
    "--level",
    "info",
    "--predicate",
    "processIdentifier == 1234",
  ]);
});
it("the iOS catalog explains which tools enable background input", async () => {
  const f = await fixture("darwin");
  await f.manager.list();
  expect(f.manager.diagnostics()).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("serve-sim or idb") }),
  );
});
for (const closing of [false, true])
  it(`${closing ? "service close" : "console shutdown"} waits for snapshot saving before any process signal`, async () => {
    const f = await fixture();
    let running = false;
    const saving = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const effects: string[] = [];
    let child: SupervisedProcess | undefined;
    const manager = new DevicePlatform({
      platform: "linux",
      home: f.home,
      env: f.env,
      after: () => () => {},
      spawn() {
        child = spawnSupervised({
          command: process.execPath,
          args: [
            "-e",
            `process.on('SIGTERM',()=>console.log('forced'));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='shutdown')console.log('saving');if(line==='finish'){console.log('saved');process.exit(0);}});`,
          ],
          env: {},
          name: "fake-emulator",
        });
        child.stdout.on("line", (line: string) => {
          effects.push(line);
          if (line === "saving") saving.resolve();
        });
        return child;
      },
      async probe(_command, args) {
        if (args.includes("-list-avds")) return { code: 0, stderr: "", stdout: "Pixel_API_35" };
        if (args[0] === "devices")
          return {
            code: 0,
            stderr: "",
            stdout: "List of devices attached\n" + (running ? "emulator-5554 device" : ""),
          };
        if (args.some((arg) => arg.includes("sys.boot_completed"))) running = true;
        if (args.includes("kill")) {
          child?.stdin.write("shutdown\n");
          if (closing) void resume.promise.then(() => child?.stdin.write("finish\n"));
        }
        if (args.includes("wait-for-any-disconnect")) {
          await resume.promise;
          child?.stdin.write("finish\n");
          running = false;
        }
        return { code: 0, stderr: "", stdout: "Pixel_API_35" };
      },
    });
    onTestFinished(async () => {
      resume.resolve();
      if (child) {
        child.stdin.write("finish\n");
        await child.stop({ graceMs: 0 });
      }
      await manager.close();
    });
    await manager.boot(android());
    const shutdown = closing ? manager.close() : manager.shutdown(android());
    await saving.promise;
    expect(effects).toEqual(["saving"]);
    expect(child?.signal.aborted).toBe(false);
    resume.resolve();
    await shutdown;
    expect(effects).toEqual(["saving", "saved"]);
  });

for (const input of [
  { kind: "longPress", x: 1, y: 2, durationMs: 8000 },
  { kind: "swipe", x: 1, y: 2, toX: 3, toY: 4, durationMs: 8000 },
  { kind: "type", text: "a".repeat(600) },
] satisfies import("@ace/protocol/devices").DeviceInput[])
  it(`Android ${input.kind} acknowledges after its gesture or typing duration`, async () => {
    const f = await fixture();
    await writeFile(f.state, "booted");
    let now = 0;
    const timers = new Set<{ at: number; run(): void }>();
    const entered = Promise.withResolvers<void>();
    let child: SupervisedProcess | undefined;
    const manager = new DevicePlatform({
      platform: "linux",
      home: f.home,
      env: f.env,
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
      spawn() {
        child = spawnSupervised({
          command: process.execPath,
          args: [
            "-e",
            `let marker,ready=false;function finish(){if(marker&&ready){console.log(marker+'0');marker=undefined;ready=false;}}require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='continue'){ready=true;finish();}else if(line.startsWith('printf')){marker=/ACE_INPUT_\\d+:/.exec(line)?.[0];finish();}else console.log('input started');});`,
          ],
          env: {},
          name: "fake-input",
        });
        child.stdout.on("line", (line: string) => {
          if (line === "input started") entered.resolve();
        });
        return child;
      },
    });
    onTestFinished(() => manager.close());
    const action = manager.input(android(), input);
    void action.catch(() => {});
    await entered.promise;
    now = input.kind === "type" ? 30000 : 8000;
    for (const timer of timers)
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }
    child?.stdin.write("continue\n");
    await action;
    expect(child?.signal.aborted).toBe(false);
  });
