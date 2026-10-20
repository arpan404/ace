/**
 * Rebuilds `ace-ui-helper.jar` from `dev/ace/uihelper/Main.java` with the Android SDK's own tools
 * (no Gradle): javac against `platforms/android-N/android.jar`, then d8 to a dex jar. Run with
 * `bun run --filter @ace/devices build:android-ui-helper` after changing the Java source, and
 * commit the jar it writes. Needs a JDK (17+) and Android build-tools.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const sdk = [
  process.env["ANDROID_HOME"],
  process.env["ANDROID_SDK_ROOT"],
  join(homedir(), "Library/Android/sdk"),
  join(homedir(), "Android/Sdk"),
].find((path): path is string => Boolean(path && existsSync(path)));
if (!sdk) throw new Error("Android SDK not found; set ANDROID_HOME");
const newest = (directory: string, pattern: RegExp) => {
  const found = readdirSync(directory)
    .filter((name) => pattern.test(name))
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!found) throw new Error(`Nothing matching ${pattern} in ${directory}`);
  return join(directory, found);
};
const androidJar = join(newest(join(sdk, "platforms"), /^android-\d+(\.\d+)?$/), "android.jar");
const d8 = join(newest(join(sdk, "build-tools"), /^\d/), "d8");
const work = mkdtempSync(join(tmpdir(), "ace-ui-helper-"));
try {
  execFileSync(
    "javac",
    [
      "-source",
      "11",
      "-target",
      "11",
      "-Xlint:-options",
      "-classpath",
      androidJar,
      "-d",
      work,
      join(here, "dev/ace/uihelper/Main.java"),
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    d8,
    [
      "--release",
      "--min-api",
      "24",
      "--lib",
      androidJar,
      "--output",
      join(here, "ace-ui-helper.jar"),
      ...readdirSync(join(work, "dev/ace/uihelper")).map((name) =>
        join(work, "dev/ace/uihelper", name),
      ),
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
