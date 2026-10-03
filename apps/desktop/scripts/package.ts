#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { build, Platform, type Configuration } from "electron-builder";
import { desktop, dist, electronVersion, targetArch } from "./common.ts";
import { verifyNatives } from "./verify-natives.ts";

/**
 * `bun run desktop:build`: an unsigned app for this machine (macOS: `.app` and dmg).
 * `bun run desktop:package`: the full platform package for one architecture (macOS dmg+zip,
 * Windows NSIS, Linux AppImage and deb), signed and notarized when the release credentials
 * are present (CSC_LINK / CSC_NAME, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
 * On macOS the Developer ID identity must already be in a keychain on the search list: the
 * screen helper is signed during the build, before electron-builder imports CSC_LINK.
 *
 * One run builds one architecture, the host's (`--arch` may name it and must match): the
 * daemon's native modules, ripgrep and the screen helper are built for the host, and the
 * build fails rather than ship them inside another architecture's package. Release CI
 * runs this once per architecture on a matching runner.
 */
const full = process.argv.includes("--full");
const arch = targetArch(process.argv);
if (!process.argv.includes("--skip-build"))
  execFileSync(process.execPath, [join(desktop, "scripts/build.ts"), "--arch", arch], {
    stdio: "inherit",
    // A release package without its screen helper would silently lose screen use.
    env: full
      ? { ...process.env, ACE_REQUIRE_SCREEN_HELPER: "1", ACE_SCREEN_SIGN_RELEASE: "1" }
      : process.env,
  });

// Also after --skip-build: dist/ may hold another architecture's build.
await verifyNatives(arch);

const notarize = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER);
const helper = join(dist, "helpers/AceScreenHelper.app");

const config: Configuration = {
  appId: "dev.ace.app",
  productName: "ace",
  executableName: "ace",
  electronVersion: electronVersion(),
  // A local build reuses the installed Electron instead of downloading it again.
  ...(full ? {} : { electronDist: join(desktop, "node_modules/electron/dist") }),
  directories: {
    app: join(dist, "app"),
    output: join(dist, "release"),
    buildResources: join(desktop, "build"),
  },
  files: ["**/*"],
  asar: true,
  // dist/app has no node_modules: everything is bundled.
  npmRebuild: false,
  // Native addons and helper binaries cannot run from inside an asar archive.
  asarUnpack: ["**/*.node", "**/spawn-helper", "**/rg", "**/rg.exe"],
  extraResources: [
    { from: join(dist, "bin"), to: "bin" },
    // The daemon's own Node runtime (none on Windows, which runs no local daemon yet).
    ...(existsSync(join(dist, "runtime")) ? [{ from: join(dist, "runtime"), to: "runtime" }] : []),
    ...(process.platform === "darwin"
      ? existsSync(helper)
        ? [{ from: join(dist, "helpers/manifest.json"), to: "screen-helper-manifest.json" }]
        : []
      : [{ from: join(dist, "helpers"), to: "helpers" }]),
  ],
  // The daemon runs as a separate Node process, so it ships as plain files. It is copied here
  // rather than through extraResources, which always drops node_modules, and the daemon needs
  // its staged runtime packages (node-pty, koffi, playwright-core, the Claude SDK).
  afterPack: async (context) => {
    const resources =
      context.electronPlatformName === "darwin"
        ? join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            "Contents/Resources",
          )
        : join(context.appOutDir, "resources");
    await cp(join(dist, "daemon"), join(resources, "daemon"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  },
  protocols: [{ name: "ace", schemes: ["ace"] }],
  electronFuses: {
    // The daemon runs on the bundled Node runtime, so nothing needs Electron as Node: with
    // this off, no local process can run arbitrary JS as the signed ace app.
    runAsNode: false,
    grantFileProtocolExtraPrivileges: false,
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
          { target: "dmg", arch: [arch] },
          { target: "zip", arch: [arch] },
        ]
      : [{ target: "dmg", arch: [arch] }],
    hardenedRuntime: true,
    entitlements: join(desktop, "build/entitlements.mac.plist"),
    entitlementsInherit: join(desktop, "build/entitlements.mac.plist"),
    notarize: full && notarize,
    // Local builds are ad-hoc signed ("-"): Apple silicon kills binaries whose signature the
    // fuse flip invalidated, and no Developer ID is needed to test locally.
    ...(full ? {} : { identity: "-" }),
    // The screen helper keeps its own stable identity (dev.ace.screen-helper), signed by
    // native/screen-helper/build.sh; re-signing would break the daemon's manifest check.
    signIgnore: ["Contents/Helpers/AceScreenHelper.app"],
    // Contents/Helpers may hold only code: the manifest goes to Resources (extraResources).
    extraFiles: existsSync(helper) ? [{ from: helper, to: "Helpers/AceScreenHelper.app" }] : [],
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
  win: { target: [{ target: "nsis", arch: [arch] }] },
  nsis: { oneClick: false, perMachine: false, include: join(desktop, "build/installer.nsh") },
  linux: {
    target: [
      { target: "AppImage", arch: [arch] },
      { target: "deb", arch: [arch] },
    ],
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
