#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, Platform, type Configuration } from "electron-builder";
import { assertLinuxRuntimeFloor } from "@ace/release/glibc";
// The canonical ace-chromium profile (PR #1221); the deb installs exactly what `ace doctor --fix` installs.
import { chromiumAppArmorProfile } from "@ace/browser/linux-sandbox";
import {
  appVersion,
  desktop,
  dist,
  electronVersion,
  installedElectronDist,
  packagedAppVersion,
  targetArch,
} from "./common.ts";
import {
  notaryCredentials,
  windowsSigning,
  windowsSigningConfig,
} from "../src/packaging/release-signing.ts";
import { writeLinuxTarball } from "./linux-tarball.ts";
import { verifyNatives } from "./verify-natives.ts";

/**
 * `bun run desktop:build`: an unsigned app for this machine (macOS: `.app` and dmg).
 * `bun run desktop:package`: the full platform package for one architecture (macOS dmg+zip,
 * Windows NSIS, Linux AppImage, deb and tar.gz) with the update feed (`app-update.yml` inside the
 * app, `latest*.yml` beside the packages; ADR 0091). On macOS it is signed with the Developer
 * ID in the keychain (CSC_NAME picks one) and notarized with whichever notarytool
 * credentials are set (see `notaryCredentials`). The identity must already be in a keychain
 * on the search list: the screen helper is signed during the build, before electron-builder
 * imports CSC_LINK. `--unsigned` builds the same full package ad-hoc signed and not
 * notarized, for releases before a Developer ID exists; those builds cannot update
 * themselves on macOS and offer the release page instead. `bun run release:build` drives
 * this for a release.
 *
 * One run builds one architecture, the host's (`--arch` may name it and must match): the
 * daemon's native modules, ripgrep and the screen helper are built for the host, and the
 * build fails rather than ship them inside another architecture's package. Release CI
 * runs this once per architecture on a matching runner.
 */
const full = process.argv.includes("--full");
const unsigned = process.argv.includes("--unsigned");
/** Signed with the release identity (macOS Developer ID, Windows CSC_LINK). */
const signed = full && !unsigned;
const arch = targetArch(process.argv);
const notary = notaryCredentials(process.env);
if (signed && process.platform === "darwin" && notary.kind === "incomplete")
  throw new Error(`Notarization needs ${notary.missing.join(", ")} as well`);
// Windows: sign when a certificate is configured, else build unsigned and say so.
const authenticode =
  process.platform === "win32" && signed ? windowsSigning(process.env) : undefined;
if (authenticode?.kind === "incomplete")
  throw new Error(`Windows signing needs ${authenticode.missing.join(", ")} as well`);
if (authenticode?.kind === "none")
  console.warn("[package] no Windows signing certificate is configured; building unsigned");
if (!process.argv.includes("--skip-build"))
  execFileSync(process.execPath, [join(desktop, "scripts/build.ts"), "--arch", arch], {
    stdio: "inherit",
    // A release package without its screen helper would silently lose screen use.
    env: full
      ? {
          ...process.env,
          ACE_REQUIRE_SCREEN_HELPER: "1",
          ...(unsigned ? {} : { ACE_SCREEN_SIGN_RELEASE: "1" }),
        }
      : process.env,
  });

// Also after --skip-build: dist/ may hold another architecture's build.
await verifyNatives(arch);
// Linux release packages run on Ubuntu 20.04+ and Debian 11+: what ace builds itself (the
// daemon's natives, its Node runtime, ripgrep, the screen helper) must not need a newer
// glibc. Electron's own floor is Chromium's. Local packages may use the host's toolchain.
if (full && process.platform === "linux")
  for (const known of await assertLinuxRuntimeFloor(
    ["daemon", "bin", "helpers", "runtime"].map((d) => join(dist, d)),
  ))
    console.warn(`[package] above the glibc floor (reviewed): ${known.path}: ${known.reason}`);
const linuxResources = join(dist, "linux");
if (process.platform === "linux") {
  await mkdir(linuxResources, { recursive: true });
  await writeFile(join(linuxResources, "apparmor-chromium"), chromiumAppArmorProfile());
}

const notarize =
  signed && process.platform === "darwin" && notary.kind !== "none" && notary.kind !== "incomplete";
const helper = join(dist, "helpers/AceScreenHelper.app");

const config: Configuration = {
  appId: "dev.ace.app",
  productName: "ace",
  executableName: "ace",
  electronVersion: electronVersion(),
  // A local build reuses the installed Electron instead of downloading it again.
  ...(full ? {} : { electronDist: installedElectronDist() }),
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
    // The tray images: macOS template and the Linux colour icon; app icons come from build/.
    {
      from: join(desktop, "resources"),
      to: "icons",
      filter: ["trayTemplate*.png", "trayColor*.png"],
    },
    // The daemon's own Node runtime.
    ...(existsSync(join(dist, "runtime")) ? [{ from: join(dist, "runtime"), to: "runtime" }] : []),
    // Windows: what the installer runs on that runtime (build/installer.nsh).
    ...(existsSync(join(dist, "setup")) ? [{ from: join(dist, "setup"), to: "setup" }] : []),
    ...(process.platform === "darwin"
      ? existsSync(helper)
        ? [{ from: join(dist, "helpers/manifest.json"), to: "screen-helper-manifest.json" }]
        : []
      : [{ from: join(dist, "helpers"), to: "helpers" }]),
    // The AppArmor profile for ace's headless Chromium (the deb installs it; see after-install).
    ...(process.platform === "linux"
      ? [{ from: join(linuxResources, "apparmor-chromium"), to: "apparmor-chromium" }]
      : []),
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
    // Encrypted cookies make Chromium's network service wait on the OS keychain before its
    // first request: on macOS a keychain password prompt then stalled the daemon socket and
    // Quit. The app keeps no secrets in cookies (the daemon token comes over the bridge from
    // ACE_HOME), and anything that can read the cookie files can read ACE_HOME's token too.
    enableCookieEncryption: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    category: "public.app-category.developer-tools",
    // Rendered from build/icon.svg by scripts/icons.ts, as is build/icon.png.
    icon: join(desktop, "build/icon.icns"),
    target: full
      ? [
          { target: "dmg", arch: [arch] },
          { target: "zip", arch: [arch] },
        ]
      : [{ target: "dmg", arch: [arch] }],
    hardenedRuntime: true,
    entitlements: join(desktop, "build/entitlements.mac.plist"),
    entitlementsInherit: join(desktop, "build/entitlements.mac.plist"),
    notarize,
    // Local and --unsigned builds are ad-hoc signed ("-"): Apple silicon kills binaries whose
    // signature the fuse flip invalidated, and no Developer ID is needed to test locally.
    ...(signed ? {} : { identity: "-" }),
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
  // A Developer ID signature on the disk image too, so Gatekeeper trusts the download.
  dmg: { sign: signed },
  win: {
    target: [{ target: "nsis", arch: [arch] }],
    icon: join(desktop, "build/icon.png"),
    // One naming scheme for every release file (`desktopAssets` in release-plan.ts).
    artifactName: "ace-${version}-${arch}-setup.${ext}",
    ...(authenticode ? windowsSigningConfig(authenticode) : {}),
  },
  nsis: { oneClick: false, perMachine: false, include: join(desktop, "build/installer.nsh") },
  linux: {
    // `ace` is the daemon CLI (`~/.ace/bin/ace`); the GUI must never install /usr/bin/ace.
    executableName: "ace-desktop",
    syncDesktopName: true,
    target: [
      { target: "AppImage", arch: [arch] },
      { target: "deb", arch: [arch] },
      // The tar.gz is written after the build, with its launcher (linux-tarball.ts).
    ],
    // Debian requires a maintainer with an email address; the project has no mailbox.
    maintainer: "ace <arpan404@users.noreply.github.com>",
    vendor: "ace",
    synopsis: "Desktop app for ace, the local multi-agent coding environment",
    category: "Development",
    // One PNG per hicolor size (`scripts/icons.ts`): the theme has no 1024 px directory.
    icon: join(desktop, "build/linux-icons"),
    artifactName: "ace-${version}-${arch}.${ext}",
    // `ace://` comes from `protocols`: electron-builder adds its handler type to the entry.
    mimeTypes: ["inode/directory"],
  },
  // The static type2 AppImage runtime (FUSE 3). The legacy default links an unversioned
  // libz.so on arm64, which a stock Ubuntu (no zlib1g-dev) does not have.
  toolsets: { appimage: "1.0.3" },
  deb: {
    packageName: "ace-desktop",
    // Its own list: electron-builder appends the `ace://` handler type to the list it is
    // given, so the deb sharing `linux.mimeTypes` with the AppImage would list it twice.
    mimeTypes: ["inode/directory"],
    // electron-builder's defaults plus ALSA, which Electron links but the defaults omit: a
    // minimal Ubuntu install failed with "libasound.so.2: cannot open shared object file".
    // The t64 name is Ubuntu 24.04+ and Debian 13+; the plain one is the older releases.
    depends: [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
    ],
    // Ours, not electron-builder's: they also install and remove ace's Chromium profile.
    afterInstall: join(desktop, "build/linux/after-install.tpl"),
    afterRemove: join(desktop, "build/linux/after-remove.tpl"),
  },
  // The update feed: GitHub releases tagged v<version>. Only a full package carries it, so
  // a local build never offers updates. Nothing uploads from here (`publish: "never"`);
  // `bun run release:publish` creates the release with the GitHub CLI.
  publish: full
    ? [{ provider: "github", owner: "arpan404", repo: "ace", releaseType: "release" }]
    : null,
};

if (!signed) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
// An unsigned Windows build must not pick up a certificate from the environment.
if (process.platform === "win32" && authenticode?.kind !== "certificate")
  for (const name of ["CSC_LINK", "WIN_CSC_LINK"]) delete process.env[name];

const targets =
  process.platform === "darwin"
    ? Platform.MAC
    : process.platform === "win32"
      ? Platform.WINDOWS
      : Platform.LINUX;
const outputs = await build({ targets: targets.createTarget(), config, publish: "never" });
if (process.platform === "linux")
  outputs.push(
    await writeLinuxTarball({
      unpacked: join(dist, "release", arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`),
      launcher: join(desktop, "build/linux/launcher.sh"),
      icon: join(desktop, "build/linux-icons/512x512.png"),
      output: join(dist, "release"),
      version: packagedAppVersion(process.env, appVersion()),
      arch,
      mtime: Number(process.env.SOURCE_DATE_EPOCH ?? 0) || 0,
    }),
  );
for (const output of outputs) console.log(`[package] ${output}`);
