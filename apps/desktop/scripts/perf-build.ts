import { copyFile, mkdir, cp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { electronBundles, repo, electronBinary, desktop } from "./common.ts";

/** The production main/preload bundles, including the N-API home-validation addon. */
export async function buildPerfDesktop(out: string): Promise<void> {
  for (const options of electronBundles(out, process.env)) await build(options);
  await mkdir(join(out, "dist"), { recursive: true });
  await copyFile(
    join(repo, "packages/workspace/dist/descriptor.node"),
    join(out, "dist/descriptor.node"),
  );
}
export async function bundlePerfMeter(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error("Missing device perf meter bundle");
  return code;
}

/** Disposable local package. Uses Electron's installed runtime and the production bundles. */
export async function packagePerfDesktop(out: string, home: string): Promise<string> {
  const binary = await electronBinary();
  const source = join(binary, "../../..");
  const app = join(home, "DevicePerf.app");
  await cp(source, app, { recursive: true, verbatimSymlinks: true });
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleIdentifier dev.ace.device-perf",
    join(app, "Contents/Info.plist"),
  ]);
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleExecutable ace-device-perf",
    join(app, "Contents/Info.plist"),
  ]);
  await rename(join(app, "Contents/MacOS/Electron"), join(app, "Contents/MacOS/ace-device-perf"));
  await rm(join(app, "Contents/Resources/default_app.asar"), { force: true });
  const resources = join(app, "Contents/Resources/app");
  await cp(out, resources, { recursive: true, verbatimSymlinks: true });
  await cp(join(desktop, "resources"), join(app, "Contents/Resources/icons"), { recursive: true });
  // The benchmark exercises the packaged renderer, not OS installation. Prevent a
  // disposable package from claiming ace:// or changing login-item registration.
  const entry = join(resources, "main.mjs");
  await writeFile(
    entry,
    'import { app as __perfOS } from "electron"; __perfOS.setAsDefaultProtocolClient = () => false; __perfOS.setLoginItemSettings = () => {};\n' +
      (await readFile(entry, "utf8")),
  );
  await writeFile(
    join(resources, "package.json"),
    JSON.stringify({ name: "ace-device-perf", version: "0.1.0", main: "main.mjs", type: "module" }),
  );
  execFileSync("codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements", app], {
    stdio: "ignore",
  });
  return join(app, "Contents/MacOS/ace-device-perf");
}
