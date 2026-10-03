#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build, Platform, type Configuration } from "electron-builder";
import { desktop, dist, electronVersion } from "./common.ts";

/**
 * `bun run desktop:build`: an unsigned app for this machine (macOS: `.app` and dmg).
 * `bun run desktop:package`: the full platform package (macOS dmg+zip for arm64 and x64,
 * Windows NSIS, Linux AppImage and deb), signed and notarized when the release credentials
 * are present (CSC_LINK / CSC_NAME, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
 */
const full = process.argv.includes("--full");
if (!process.argv.includes("--skip-build"))
  execFileSync(process.execPath, [join(desktop, "scripts/build.ts")], { stdio: "inherit" });

const notarize = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER);
const helper = join(dist, "helpers/AceScreenHelper.app");

const config: Configuration = {
  appId: "dev.ace.app",
  productName: "ace",
  executableName: "ace",
  electronVersion: electronVersion(),
  directories: {
    app: join(dist, "app"),
    output: join(dist, "release"),
    buildResources: join(desktop, "build"),
  },
  files: ["**/*"],
  asar: true,
  // Native addons and helper binaries cannot run from inside an asar archive.
  asarUnpack: ["**/*.node", "**/spawn-helper", "**/rg", "**/rg.exe"],
  // The daemon runs as a separate Node process, so it ships as plain files.
  extraResources: [
    { from: join(dist, "daemon"), to: "daemon" },
    { from: join(dist, "bin"), to: "bin" },
    ...(process.platform === "darwin" ? [] : [{ from: join(dist, "helpers"), to: "helpers" }]),
  ],
  protocols: [{ name: "ace", schemes: ["ace"] }],
  electronFuses: {
    // The bundled daemon runs on Electron's own Node: ELECTRON_RUN_AS_NODE must stay on.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    category: "public.app-category.developer-tools",
    target: full
      ? [
          { target: "dmg", arch: ["arm64", "x64"] },
          { target: "zip", arch: ["arm64", "x64"] },
        ]
      : [{ target: "dmg", arch: [process.arch === "arm64" ? "arm64" : "x64"] }],
    hardenedRuntime: true,
    entitlements: join(desktop, "build/entitlements.mac.plist"),
    entitlementsInherit: join(desktop, "build/entitlements.mac.plist"),
    notarize: full && notarize,
    // Unsigned local builds skip identity lookup entirely.
    ...(full ? {} : { identity: null }),
    // The screen helper keeps its own stable identity (dev.ace.screen-helper), signed by
    // native/screen-helper/build.sh; re-signing would break the daemon's manifest check.
    signIgnore: ["Contents/Helpers/AceScreenHelper.app"],
    extraFiles: existsSync(helper)
      ? [
          { from: helper, to: "Helpers/AceScreenHelper.app" },
          { from: join(dist, "helpers/manifest.json"), to: "Helpers/manifest.json" },
        ]
      : [],
    extendInfo: {
      // "Open With → ace" and dropping folders on the dock icon.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Folder",
          CFBundleTypeRole: "Viewer",
          LSItemContentTypes: ["public.folder"],
        },
      ],
      NSScreenCaptureUsageDescription: "ace shows only apps you explicitly approve.",
    },
  },
  dmg: { sign: false },
  win: { target: [{ target: "nsis", arch: ["x64", "arm64"] }] },
  nsis: { oneClick: false, perMachine: false, include: join(desktop, "build/installer.nsh") },
  linux: {
    target: ["AppImage", "deb"],
    category: "Development",
    mimeTypes: ["x-scheme-handler/ace", "inode/directory"],
  },
  publish: null,
};

if (!full) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

const targets =
  process.platform === "darwin"
    ? Platform.MAC
    : process.platform === "win32"
      ? Platform.WINDOWS
      : Platform.LINUX;
const outputs = await build({ targets: targets.createTarget(), config, publish: "never" });
for (const output of outputs) console.log(`[package] ${output}`);
