import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { targetsOf, undeclared } from "./privacy-manifest.ts";

const ios = join(import.meta.dirname, "..");

/** Every Swift file under a target source path (a folder or one file), and its manifest. */
function read(sources: string[]) {
  const files: { path: string; text: string }[] = [];
  let manifest: string | undefined;
  const walk = (path: string) => {
    const full = join(ios, path);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full)) walk(join(path, entry));
    } else if (path.endsWith(".swift")) {
      files.push({ path, text: readFileSync(full, "utf8") });
    } else if (path.endsWith("PrivacyInfo.xcprivacy")) {
      manifest = readFileSync(full, "utf8");
    }
  };
  for (const source of sources) walk(source);
  return { files, manifest };
}

test("the app and each of its extensions declare a reason for every required-reason API they compile", () => {
  const shipped = targetsOf(readFileSync(join(ios, "project.yml"), "utf8")).filter(
    (target) => target.type === "application" || target.type === "app-extension",
  );
  expect(shipped.map((target) => target.name)).toEqual(
    expect.arrayContaining(["Ace", "AceActivity", "AceShare", "AceNotificationService"]),
  );
  const problems = shipped.flatMap((target) => {
    const { files, manifest } = read(target.sources);
    return undeclared(target.name, files, manifest);
  });
  expect(problems).toEqual([]);
});

const manifest = (category: string) =>
  `<dict><key>NSPrivacyAccessedAPIType</key><string>${category}</string>
   <key>NSPrivacyAccessedAPITypeReasons</key><array><string>35F9.1</string></array></dict>`;

test.each([
  ["boot time", "let t = ProcessInfo.processInfo.systemUptime", "SystemBootTime"],
  ["file timestamps", "try FileManager.default.attributesOfItem(atPath: p)", "FileTimestamp"],
  ["disk space", "values.volumeAvailableCapacityForImportantUsage", "DiskSpace"],
  ["app-group defaults", "UserDefaults(suiteName: group)", "UserDefaults"],
  ["keyboards", "UITextInputMode.activeInputModes", "ActiveKeyboards"],
])("a target reading %s is reported until its manifest gives a reason", (_, code, category) => {
  const files = [{ path: "Widgets/W.swift", text: code }];
  const full = `NSPrivacyAccessedAPICategory${category}`;
  expect(undeclared("W", files, undefined)).toEqual([
    `W uses ${full} (Widgets/W.swift) and has no PrivacyInfo.xcprivacy`,
  ]);
  expect(undeclared("W", files, manifest("NSPrivacyAccessedAPICategoryUserDefaultsX"))).toEqual([
    `W uses ${full} (Widgets/W.swift) without a reason`,
  ]);
  expect(undeclared("W", files, manifest(full))).toEqual([]);
});
