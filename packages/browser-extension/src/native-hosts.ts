import { join } from "node:path";
import { userBrowserHostName } from "@ace/protocol";

/** One browser's per-user native messaging directory, and the data root that shows it is installed. */
export interface NativeHostTarget {
  browser: string;
  /** The browser's user data directory; present only when the browser has run. */
  root: string;
  dir: string;
}

const macRoots = [
  ["Chrome", "Google/Chrome"],
  ["Chrome Beta", "Google/Chrome Beta"],
  ["Chrome Dev", "Google/Chrome Dev"],
  ["Chrome Canary", "Google/Chrome Canary"],
  ["Chromium", "Chromium"],
  ["Edge", "Microsoft Edge"],
  ["Brave", "BraveSoftware/Brave-Browser"],
  ["Vivaldi", "Vivaldi"],
  ["Arc", "Arc/User Data"],
] as const;
const linuxRoots = [
  ["Chrome", "google-chrome"],
  ["Chrome Beta", "google-chrome-beta"],
  ["Chrome Dev", "google-chrome-unstable"],
  ["Chromium", "chromium"],
  ["Edge", "microsoft-edge"],
  ["Brave", "BraveSoftware/Brave-Browser"],
  ["Vivaldi", "vivaldi"],
] as const;

/**
 * Per-user native messaging host directories (ADR 0084). Pure: the platform and home directory
 * are inputs. Windows registers hosts in the registry instead and returns none here.
 */
export function nativeHostTargets(
  platform: NodeJS.Platform,
  home: string,
  env: { XDG_CONFIG_HOME?: string | undefined } = {},
): NativeHostTarget[] {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const roots: { browser: string; root: string }[] =
    platform === "darwin"
      ? macRoots.map(([browser, path]) => ({
          browser,
          root: join(home, "Library/Application Support", path),
        }))
      : platform === "linux"
        ? linuxRoots.map(([browser, path]) => ({ browser, root: join(configHome, path) }))
        : [];
  return roots.map(({ browser, root }) => ({
    browser,
    root,
    dir: join(root, "NativeMessagingHosts"),
  }));
}

/** Chrome's native host manifest: only ace for Chrome's own origin may start the host. */
export function nativeHostManifest(path: string, allowedOrigins: readonly string[]) {
  return {
    name: userBrowserHostName,
    description: "ace: lets ace for Chrome reach the ace daemon on this computer",
    path,
    type: "stdio",
    allowed_origins: [...allowedOrigins],
  };
}

/** POSIX single-quoted shell word. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The executable Chrome starts: the daemon's own Node running the host entry. */
export function launcherScript(options: { node: string; entry: string; dataDir: string }): string {
  return `#!/bin/sh
# Written by ace for "Use my Chrome" (ADR 0084). Chrome starts this as a native messaging host.
exec ${quote(options.node)} ${quote(options.entry)} --data-dir ${quote(options.dataDir)} "$@"
`;
}

// Windows hosts live in HKCU keys, which the 32- and 64-bit registry views share.
const windowsRoots = [
  ["Chrome", "Google/Chrome/User Data", "Google\\Chrome"],
  ["Edge", "Microsoft/Edge/User Data", "Microsoft\\Edge"],
  ["Chromium", "Chromium/User Data", "Chromium"],
] as const;

/** Windows: each browser's user data root and the HKCU key whose default value names the manifest. */
export function windowsHostKeys(home: string, env: { LOCALAPPDATA?: string | undefined } = {}) {
  const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
  return windowsRoots.map(([browser, path, vendor]) => ({
    browser,
    root: join(local, path),
    key: `Software\\${vendor}\\NativeMessagingHosts\\${userBrowserHostName}`,
  }));
}

/** cmd.exe quoted word; `%` doubles so variable expansion never rewrites a path. */
function batchWord(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error("Invalid native host path");
  return `"${value.replaceAll("%", "%%")}"`;
}

/** The Windows launcher. cmd.exe reads batch lines in the OEM code page, so switch to UTF-8 first. */
export function windowsLauncherScript(options: {
  node: string;
  entry: string;
  dataDir: string;
}): string {
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${batchWord(options.node)} ${batchWord(options.entry)} --data-dir ${batchWord(options.dataDir)} %*\r\n`;
}
