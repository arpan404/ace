import type { DeviceRow } from "./devices.ts";
import { expect, test } from "vitest";
import { deviceCatalog, deviceKind, iphoneCutout, rememberUse } from "./device-catalog.ts";

function row(
  name: string,
  platform: DeviceRow["platform"],
  options: { running?: boolean; live?: boolean; runtime?: string } = {},
): DeviceRow {
  const runtime = options.runtime ?? (platform === "ios" ? "iOS 26.0" : "Android 16");
  return {
    id: `${platform}:${name}`,
    name,
    platform,
    runtime,
    detail: `${runtime} · ${options.running ? "Running" : "Off"}`,
    running: options.running ?? false,
    live: options.live ?? false,
  };
}

const rows = [
  row("iPhone 17 Pro", "ios", { running: true }),
  row("iPhone SE (3rd generation)", "ios"),
  row("iPad Air 11-inch (M3)", "ios", { running: true, live: true }),
  row("Apple Watch Series 11 (46mm)", "ios", { runtime: "watchOS 26.0" }),
  row("Pixel 9", "android"),
  row("Pixel Tablet", "android"),
  row("Galaxy Tab S9", "android", { running: true }),
];
const everything = { query: "", platform: "all" as const, uses: [] };

test("every device is grouped under its kind, in a fixed kind order, leaving out empty kinds", () => {
  const { groups } = deviceCatalog(rows, everything);
  expect(groups.map((group) => [group.label, group.rows.map((entry) => entry.name)])).toEqual([
    ["iPhone", ["iPhone 17 Pro", "iPhone SE (3rd generation)"]],
    ["iPad", ["iPad Air 11-inch (M3)"]],
    ["Apple Watch", ["Apple Watch Series 11 (46mm)"]],
    ["Android phone", ["Pixel 9"]],
    ["Android tablet", ["Pixel Tablet", "Galaxy Tab S9"]],
  ]);
});

test("running devices lead, the live ones first", () => {
  const { running } = deviceCatalog(rows, everything);
  expect(running.map((entry) => entry.name)).toEqual([
    "iPad Air 11-inch (M3)",
    "iPhone 17 Pro",
    "Galaxy Tab S9",
  ]);
});

test("the search matches every word against the name, OS version and kind, ignoring case", () => {
  const names = (query: string) =>
    deviceCatalog(rows, { ...everything, query }).groups.flatMap((group) =>
      group.rows.map((entry) => entry.name),
    );
  expect(names("pixel")).toEqual(["Pixel 9", "Pixel Tablet"]);
  expect(names("watchos")).toEqual(["Apple Watch Series 11 (46mm)"]);
  expect(names("android tablet")).toEqual(["Pixel Tablet", "Galaxy Tab S9"]);
  expect(names("iphone se")).toEqual(["iPhone SE (3rd generation)"]);
  expect(deviceCatalog(rows, { ...everything, query: "nokia" }).matches).toBe(0);
});

test("the platform filter narrows every section", () => {
  const android = deviceCatalog(rows, {
    query: "",
    platform: "android",
    uses: [{ id: "ios:iPhone SE (3rd generation)", at: 5 }],
  });
  expect(android.running.map((entry) => entry.name)).toEqual(["Galaxy Tab S9"]);
  expect(android.recent).toEqual([]);
  expect(android.groups.map((group) => group.kind)).toEqual(["android-phone", "android-tablet"]);
  expect(android.matches).toBe(3);
});

test("recent lists the devices used lately that aren't running, newest first", () => {
  const { recent } = deviceCatalog(rows, {
    ...everything,
    uses: [
      { id: "android:Pixel 9", at: 10 },
      { id: "ios:iPhone 17 Pro", at: 30 },
      { id: "ios:Apple Watch Series 11 (46mm)", at: 20 },
      { id: "ios:a device that was deleted", at: 40 },
    ],
  });
  expect(recent.map((entry) => [entry.row.name, entry.at])).toEqual([
    ["Apple Watch Series 11 (46mm)", 20],
    ["Pixel 9", 10],
  ]);
});

test("remembering a use puts it first, keeps each device once and keeps the newest five", () => {
  let uses = rememberUse([], "a", 1);
  for (const [id, at] of [
    ["b", 2],
    ["c", 3],
    ["a", 4],
    ["d", 5],
    ["e", 6],
    ["f", 7],
  ] as const)
    uses = rememberUse(uses, id, at);
  expect(uses).toEqual([
    { id: "f", at: 7 },
    { id: "e", at: 6 },
    { id: "d", at: 5 },
    { id: "a", at: 4 },
    { id: "c", at: 3 },
  ]);
});

test("a device's kind comes from its platform and name", () => {
  expect(deviceKind({ name: "iPad mini (A17 Pro)", platform: "ios" })).toBe("ipad");
  expect(deviceKind({ name: "Apple TV 4K (3rd generation)", platform: "ios" })).toBe("tv");
  expect(deviceKind({ name: "Apple Vision Pro", platform: "ios" })).toBe("vision");
  expect(deviceKind({ name: "Medium Phone", platform: "android" })).toBe("android-phone");
  expect(deviceKind({ name: "Medium Tablet", platform: "android" })).toBe("android-tablet");
});

test("each iPhone gets the screen cut it has: a Dynamic Island, a notch or none", () => {
  expect(iphoneCutout("iPhone 17 Pro Max")).toBe("island");
  expect(iphoneCutout("iPhone 15")).toBe("island");
  expect(iphoneCutout("iPhone 14 Pro")).toBe("island");
  expect(iphoneCutout("iPhone Air")).toBe("island");
  expect(iphoneCutout("iPhone 16e")).toBe("notch");
  expect(iphoneCutout("iPhone 14")).toBe("notch");
  expect(iphoneCutout("iPhone 11")).toBe("notch");
  expect(iphoneCutout("iPhone SE (3rd generation)")).toBe("none");
  expect(iphoneCutout("iPhone 8 Plus")).toBe("none");
});
