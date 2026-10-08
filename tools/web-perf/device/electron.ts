import { loadavg, homedir } from "node:os";
import {
  buildPerfDesktop,
  bundlePerfMeter,
  packagePerfDesktop,
} from "../../../apps/desktop/scripts/perf-build.ts";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { _electron, type ElectronApplication } from "@playwright/test";
import { startDaemon, readConfig, createDevThread } from "../../../apps/daemon/src/index.ts";
import {
  appEnvironment,
  electronBinary,
  mainEntry,
  desktop,
  repo,
} from "../../../apps/desktop/scripts/common.ts";
import { z } from "zod";

const percentile = (v: number[], p: number) =>
  v.toSorted((a, b) => a - b)[Math.floor((v.length - 1) * p)] ?? null;
const stats = (v: number[]) => ({
  p50: percentile(v, 0.5),
  p95: percentile(v, 0.95),
  samples: v.length,
});

const home = process.env["ACE_HOME"];
const udid = process.env["ACE_PERF_UDID"];
const deviceName = process.env["ACE_PERF_DEVICE_NAME"] ?? "ace-perf";
let sourceClock = { offset: 0, uncertainty: 0 };
const androidSerial = process.env["ACE_PERF_ANDROID_SERIAL"];
if (androidSerial) {
  const adb = join(
    process.env["ANDROID_HOME"] ?? join(homedir(), "Library/Android/sdk"),
    "platform-tools/adb",
  );
  const clocks = Array.from({ length: 5 }, () => {
    const before = Date.now();
    const deviceTime = z.coerce
      .number()
      .finite()
      .parse(
        execFileSync(adb, ["-s", androidSerial, "shell", "date", "+%s%3N"], {
          encoding: "utf8",
          timeout: 10000,
        }).trim(),
      );
    const after = Date.now();
    return { offset: (before + after) / 2 - deviceTime, uncertainty: (after - before) / 2 };
  });
  sourceClock = clocks.toSorted((a, b) => a.uncertainty - b.uncertainty)[0] ?? sourceClock;
}
if (
  !(
    home?.startsWith("/tmp/ace-device-perf.") || home?.startsWith("/private/tmp/ace-device-perf.")
  ) ||
  !(udid || process.env["ACE_PERF_DEVICE_NAME"])
)
  throw new Error("Run the device perf wrapper");

const out = join(desktop, "dist/device-perf");
await buildPerfDesktop(out);
if (
  process.env["ACE_PERF_REBUILD"] === "1" ||
  !(await access(join(out, "renderer/index.html")).then(
    () => true,
    () => false,
  ))
)
  execFileSync(
    "bun",
    ["x", "vite", "build", "--outDir", join(out, "renderer"), "--logLevel", "warn"],
    { cwd: join(repo, "apps/web"), stdio: "inherit" },
  );
const daemon = await startDaemon({
  config: readConfig({ ...process.env, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  modelInstances: [],
  engine: {
    adapterDiscovery: async () => ({
      claude: { installed: false, auth: "unknown", loginHint: "" },
      codex: { installed: false, auth: "unknown", loginHint: "" },
      cursor: { installed: false, auth: "unknown", loginHint: "" },
      opencode: { installed: false, auth: "unknown", loginHint: "" },
    }),
  },
});
await mkdir(join(home, "project"), { recursive: true });
const workspace = daemon.store.createWorkspace(join(home, "project"), "Device perf");
const thread = createDevThread(daemon.store, workspace, "Device performance");
await writeFile(join(home, "daemon-endpoint"), daemon.url.replace(/^ws/, "http") + "\n", {
  mode: 0o600,
});
let app: ElectronApplication;
try {
  app = await _electron.launch({
    executablePath:
      process.env["ACE_PERF_PACKAGED"] === "1"
        ? await packagePerfDesktop(out, home)
        : await electronBinary(),
    args:
      process.env["ACE_PERF_PACKAGED"] === "1" ? ["--use-mock-keychain"] : [join(out, mainEntry)],
    env: {
      ...appEnvironment(process.env),
      ACE_HOME: await realpath(home),
      ACE_DESKTOP_DAEMON: "attach",
      ACE_DESKTOP_USER_DATA: join(home, "user-data"),
      ACE_DESKTOP_RENDERER_URL: "",
    },
  });
} catch (error) {
  await daemon.close();
  throw error;
}
app.process().stderr?.on("data", (data: Buffer) => console.error(data.toString()));
app.process().stdout?.on("data", (data: Buffer) => console.error(data.toString()));
try {
  // Wait for production startup to register the window and IPC trust before navigation.
  const page = await app.firstWindow({ timeout: 60000 });
  const displays = await app.evaluate(({ screen }) =>
    screen
      .getAllDisplays()
      .map((display) => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })),
  );
  await app.evaluate(({ BrowserWindow, screen }) => {
    const display = screen.getAllDisplays().toSorted((a, b) => b.scaleFactor - a.scaleFactor)[0];
    const window = BrowserWindow.getAllWindows()[0];
    if (display && window)
      window.setBounds({
        x: display.bounds.x + 20,
        y: display.bounds.y + 40,
        width: Math.min(1440, display.bounds.width - 40),
        height: Math.min(960, display.bounds.height - 80),
      });
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  page.on("pageerror", (e) => console.error(e.message));
  const meter = await bundlePerfMeter(join(repo, "tools/web-perf/device/meter.ts"));
  await page.addInitScript(
    (offset) => Reflect.set(globalThis, "deviceSourceOffset", offset),
    sourceClock.offset,
  );
  await page.addInitScript({ content: meter });
  await page.getByRole("navigation", { name: "Views" }).waitFor({ timeout: 60000 });
  await page.goto(`app://ace/t/${thread.id}`);
  await page.getByRole("navigation", { name: "Views" }).waitFor({ timeout: 60000 });
  await page.keyboard.press("Control+Shift+m");
  await page.getByRole("button", { name: "Enable devices", exact: true }).click({ timeout: 30000 });
  await page.getByRole("button", { name: new RegExp(`^${deviceName}`) }).click({ timeout: 30000 });
  const panel = page.getByRole("region", { name: deviceName, exact: true });
  const canvas = panel.getByRole("img", { name: `${deviceName} screen` });
  await canvas.waitFor({ timeout: 60000 });
  await page.waitForFunction(
    (name) =>
      Number(
        Array.from(document.querySelectorAll("canvas"))
          .find((c) => c.getAttribute("aria-label") === `${name} screen`)
          ?.getAttribute("data-frame"),
      ) > 10,
    deviceName,
    { timeout: 60000 },
  );
  // A device's control toggle (components/control-toggle.tsx), not the browser's pill.
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  if (process.env["ACE_PERF_SPACE"] === "1")
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setFullScreen(true),
    );
  await page.waitForTimeout(3000);
  await page.evaluate(() => Reflect.get(globalThis, "deviceMeter").start());
  const start = Date.now();
  const failures: string[] = [];
  for (let i = 0; i < 10; i++) {
    try {
      await page.evaluate(() => Reflect.get(globalThis, "deviceMeter").input("tap"));
      const tapBox = await canvas.boundingBox();
      if (!tapBox) throw new Error("Canvas missing");
      await canvas.click({ position: { x: tapBox.width * 0.4, y: tapBox.height * 0.3 } });
      await page.waitForFunction(
        () => Reflect.get(globalThis, "deviceMeter").acknowledged(),
        undefined,
        { timeout: 2500 },
      );
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Device canvas missing");
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.evaluate(() => Reflect.get(globalThis, "deviceMeter").input("swipe"));
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(
        () => Reflect.get(globalThis, "deviceMeter").acknowledged(),
        undefined,
        { timeout: 2500 },
      );
      await page.getByRole("textbox", { name: "Type on the device" }).fill("a");
      await page.evaluate(() => Reflect.get(globalThis, "deviceMeter").input("type"));
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(
        () => Reflect.get(globalThis, "deviceMeter").acknowledged(),
        undefined,
        { timeout: 2500 },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }
  const elapsed = Date.now() - start;
  const record = z
    .object({
      frames: z.number(),
      codecs: z.record(z.string(), z.number()),
      capture: z.array(z.number()),
      source: z.array(z.number()),
      inputs: z.record(z.string(), z.array(z.number())),
      requests: z.array(z.unknown()),
      errors: z.array(z.unknown()),
      acknowledgements: z.array(z.unknown()),
    })
    .parse(await page.evaluate(() => Reflect.get(globalThis, "deviceMeter").stop()));
  const result = {
    failures,
    errors: record.errors,
    acknowledgements: record.acknowledgements,
    hostLoad: loadavg(),
    sourceClock,
    displays,
    packaged: await app.evaluate(({ app: electronApp }) => electronApp.isPackaged),
    fps: (record.frames * 1000) / elapsed,
    codecs: record.codecs,
    capture: stats(record.capture),
    source: stats(record.source),
    inputs: Object.fromEntries(Object.entries(record.inputs).map(([k, v]) => [k, stats(v)])),
    resolution: await canvas
      .evaluate((c) => ({
        width: Number(c.getAttribute("width")),
        height: Number(c.getAttribute("height")),
        css: { width: c.getBoundingClientRect().width, height: c.getBoundingClientRect().height },
        dpr: devicePixelRatio,
      }))
      .catch(() => null),
    requests: record.requests,
    gpu: await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus()),
  };
  console.log(JSON.stringify(result, null, 2));
  const destination = process.env["ACE_PERF_OUTPUT"];
  if (destination) await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
  await page.screenshot({ path: join(home, "devices.png") });
  if (
    process.env["ACE_PERF_ASSERT"] === "1" &&
    (failures.length > 0 ||
      !result.resolution ||
      result.resolution.width < result.resolution.css.width * result.resolution.dpr - 2 ||
      result.resolution.height < result.resolution.css.height * result.resolution.dpr - 2 ||
      !(result.codecs["h264"] && !result.codecs["jpeg"]) ||
      record.errors.length > 0 ||
      result.fps < 45 ||
      (result.source.p50 ?? Infinity) > 60 ||
      (result.source.p95 ?? Infinity) > 120 ||
      ["tap", "swipe", "type"].some((kind) => {
        const v = result.inputs[kind];
        return !v || v.samples < 8 || (v.p50 ?? Infinity) > 160 || (v.p95 ?? Infinity) > 250;
      }))
  )
    throw new Error("Device live view performance budget exceeded");
} catch (error) {
  const window = app.windows()[0];
  if (window) console.error(await window.locator("body").innerText());
  throw error;
} finally {
  try {
    await app.close();
  } finally {
    await daemon.close();
  }
}
