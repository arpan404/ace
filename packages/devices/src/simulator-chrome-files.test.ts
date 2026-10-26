import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSmallFile } from "./device-chrome-sources.ts";
import { readSimulatorChrome, type SimulatorChromeSource } from "./simulator-chrome-files.ts";
import { tinyPdf } from "./testing/tiny-pdf.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ace-chrome-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deviceType = "com.apple.CoreSimulator.SimDeviceType.Test-Phone";
const black = (width: number, height: number) =>
  tinyPdf(width, height, `0 0 0 rg 0 0 ${width} ${height} re f`);

/**
 * A Mac's files for one phone, laid out as Xcode lays them out: a device type whose profile
 * names a chrome, a mask and a notch, and that chrome's nine body pieces and two buttons.
 */
function install(
  options: { profile?: Record<string, unknown>; chrome?: Record<string, unknown> } = {},
) {
  const bundle = join(root, "DeviceTypes/Test Phone.simdevicetype");
  const resources = join(bundle, "Contents/Resources");
  mkdirSync(resources, { recursive: true });
  const profile = {
    mainScreenWidth: 1170,
    mainScreenHeight: 2532,
    mainScreenScale: 3,
    framebufferMask: "MASK",
    sensorBarImage: "notch",
    chromeIdentifier: "com.apple.dt.devicekit.chrome.testphone",
    // Fields ace doesn't use are ignored, whatever they hold.
    supportedFeatures: { "com.apple.hid.keyboard": true },
    modelIdentifier: 42,
    ...options.profile,
  };
  writeFileSync(join(resources, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(resources, "MASK.pdf"), black(1170, 2532));
  writeFileSync(join(resources, "notch.pdf"), black(176, 34));
  const chromeResources = join(root, "Chrome/testphone.devicechrome/Contents/Resources");
  mkdirSync(chromeResources, { recursive: true });
  const names = ["TL", "T", "TR", "R", "BR", "B", "BL", "L", "Vol", "Power"];
  for (const name of names) writeFileSync(join(chromeResources, `${name}.pdf`), black(16, 64));
  writeFileSync(
    join(chromeResources, "chrome.json"),
    JSON.stringify({
      identifier: "com.apple.dt.devicekit.chrome.testphone",
      images: {
        topLeft: "TL",
        top: "T",
        topRight: "TR",
        right: "R",
        bottomRight: "BR",
        bottom: "B",
        bottomLeft: "BL",
        left: "L",
        sizing: { leftWidth: 22, rightWidth: 22, topHeight: 22, bottomHeight: 22 },
      },
      inputs: [
        {
          name: "volume-up",
          accessibilityTitle: "Volume Up",
          image: "Vol",
          anchor: "left",
          align: "leading",
          offsets: { normal: { x: 8, y: 221 }, rollover: { x: 3, y: 221 } },
        },
        {
          name: "power",
          image: "Power",
          anchor: "right",
          align: "leading",
          offsets: { normal: { x: -8, y: 262 } },
        },
        // A button this version of ace can't read is left out, not fatal.
        { name: "mystery", anchor: "sideways" },
      ],
      ...options.chrome,
    }),
  );
  return bundle;
}

function source(bundle: string): SimulatorChromeSource {
  return {
    deviceTypes: async () =>
      JSON.stringify({ devicetypes: [{ identifier: deviceType, bundlePath: bundle, name: "x" }] }),
    // Stands in for `plutil -convert json`: the profile is already JSON here.
    plistJson: async (path) => {
      const bytes = await readSmallFile(path.replace(/profile\.plist$/, "profile.json"));
      if (!bytes) throw new Error("plutil failed");
      return Buffer.from(bytes).toString("utf8");
    },
    readFile: readSmallFile,
    chromeRoots: [join(root, "Missing"), join(root, "Chrome")],
  };
}

test("a Simulator's look is its chrome's body around its screen, with Apple's mask, notch and buttons", async () => {
  const chrome = await readSimulatorChrome(source(install()), deviceType);

  // 1170 × 2532 pixels at 3× is a 390 × 844 point screen, 22 points inside the body.
  expect(chrome?.screen).toEqual({ x: 22, y: 22, width: 390, height: 844 });
  expect(chrome?.body).toMatchObject({ width: 434, height: 888 });
  expect(chrome?.body.image).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(chrome?.mask).toMatch(/^data:image\/svg\+xml;base64,/);
  // The notch hangs from the top of the screen, centred.
  expect(chrome?.cutout?.rect).toEqual({ x: 129, y: 22, width: 176, height: 34 });
  // Buttons stand out 8 points from the edge they're anchored to.
  expect(chrome?.buttons.map(({ name, title, rect }) => ({ name, title, rect }))).toEqual([
    { name: "volume-up", title: "Volume Up", rect: { x: -8, y: 221, width: 16, height: 64 } },
    { name: "power", title: undefined, rect: { x: 426, y: 262, width: 16, height: 64 } },
  ]);
});

test("a chrome's composite drawn for this screen size is the body, so no seams show", async () => {
  const bundle = install({ chrome: {} });
  const resources = join(root, "Chrome/testphone.devicechrome/Contents/Resources");
  writeFileSync(join(resources, "Whole.pdf"), black(432, 886));
  const file = join(resources, "chrome.json");
  const json = JSON.parse(Buffer.from((await readSmallFile(file)) ?? []).toString("utf8"));
  json.images.composite = "Whole";
  writeFileSync(file, JSON.stringify(json));

  const chrome = await readSimulatorChrome(source(bundle), deviceType);

  expect(chrome?.body).toMatchObject({ width: 432, height: 886 });
  expect(chrome?.screen).toEqual({ x: 21, y: 21, width: 390, height: 844 });
});

test("an island iPhone gets no notch: its sensor bar draws nothing", async () => {
  const bundle = install();
  writeFileSync(join(bundle, "Contents/Resources/notch.pdf"), tinyPdf(393, 47, "q Q"));
  const chrome = await readSimulatorChrome(source(bundle), deviceType);
  expect(chrome).toBeDefined();
  expect(chrome?.cutout).toBeUndefined();
});

test("a device type whose chrome is missing a body piece has no look, so the drawn frame stays", async () => {
  const bundle = install();
  rmSync(join(root, "Chrome/testphone.devicechrome/Contents/Resources/BL.pdf"));
  expect(await readSimulatorChrome(source(bundle), deviceType)).toBeUndefined();
});

test("a device type Xcode doesn't list, or whose profile names no chrome, has no look", async () => {
  const bundle = install({ profile: { chromeIdentifier: undefined } });
  expect(await readSimulatorChrome(source(bundle), deviceType)).toBeUndefined();
  expect(
    await readSimulatorChrome(source(install()), "com.apple.CoreSimulator.SimDeviceType.Other"),
  ).toBeUndefined();
});

test("a profile naming a resource outside its bundle is never read", async () => {
  const bundle = install({ profile: { framebufferMask: "../../../../secret" } });
  writeFileSync(join(root, "secret.pdf"), black(10, 10));
  const chrome = await readSimulatorChrome(source(bundle), deviceType);
  expect(chrome?.mask).toBeUndefined();
});
