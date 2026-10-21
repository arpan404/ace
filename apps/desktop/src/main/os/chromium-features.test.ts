import { expect, test } from "vitest";
import { enableFeatures, linuxFeatures, type FeatureSwitches } from "./chromium-features.ts";

/** A command line that, like Chromium's, keeps only the last value of a repeated switch. */
function commandLine(initial?: string): FeatureSwitches & { value(): string } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("enable-features", initial);
  return {
    getSwitchValue: (name) => values.get(name) ?? "",
    appendSwitch: (name, value) => void values.set(name, value),
    value: () => values.get("enable-features") ?? "",
  };
}

test("Linux enables the GlobalShortcuts portal so Wayland sessions can register the quick-thread shortcut", () => {
  const line = commandLine();
  enableFeatures(line, linuxFeatures("linux"));
  expect(line.value()).toBe("GlobalShortcutsPortal");
});

test("features someone already enabled survive adding the portal", () => {
  const line = commandLine("WaylandWindowDecorations, VaapiVideoDecoder");
  enableFeatures(line, linuxFeatures("linux"));
  expect(line.value()).toBe("WaylandWindowDecorations,VaapiVideoDecoder,GlobalShortcutsPortal");
});

test("an already enabled portal is not listed twice", () => {
  const line = commandLine("GlobalShortcutsPortal");
  enableFeatures(line, linuxFeatures("linux"));
  expect(line.value()).toBe("GlobalShortcutsPortal");
});

test.each(["darwin", "win32"] as const)("%s leaves Chromium's features alone", (platform) => {
  const line = commandLine();
  enableFeatures(line, linuxFeatures(platform));
  expect(line.value()).toBe("");
});
