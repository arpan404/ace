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

/** Windows: `%LOCALAPPDATA%`, where browsers keep user data and ace keeps its host launchers. */
export function windowsLocalAppData(home: string, env: { LOCALAPPDATA?: string | undefined } = {}) {
  return env.LOCALAPPDATA || join(home, "AppData", "Local");
}

/** Windows: each browser's user data root and the HKCU key whose default value names the manifest. */
export function windowsHostKeys(home: string, env: { LOCALAPPDATA?: string | undefined } = {}) {
  const local = windowsLocalAppData(home, env);
  return windowsRoots.map(([browser, path, vendor]) => ({
    browser,
    root: join(local, path),
    key: `Software\\${vendor}\\NativeMessagingHosts\\${userBrowserHostName}`,
  }));
}

/** cmd.exe quoted word. `%` doubles so variable expansion never rewrites a path, and trailing
 * backslashes double so Node's argument parser doesn't read `\"` as an escaped quote. */
function batchWord(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error("Invalid native host path");
  return `"${value.replaceAll("%", "%%").replace(/\\+$/, (slashes) => slashes + slashes)}"`;
}

/**
 * The Windows launcher. cmd.exe reads batch lines in the console code page, so it switches to
 * UTF-8 before the line with paths, then restores the caller's code page (the console may be
 * shared) and returns Node's exit code. Nothing but Node writes to stdout, the message channel.
 */
export function windowsLauncherScript(options: {
  node: string;
  entry: string;
  dataDir: string;
}): string {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "ace_cp="',
    `for /f "tokens=2 delims=:" %%a in ('chcp 2^>nul') do for /f "tokens=1 delims=. " %%b in ("%%a") do set "ace_cp=%%b"`,
    'if defined ace_cp for /f "delims=0123456789" %%c in ("%ace_cp%") do set "ace_cp="',
    "chcp 65001 >nul 2>nul",
    `${batchWord(options.node)} ${batchWord(options.entry)} --data-dir ${batchWord(options.dataDir)} %*`,
    'set "ace_status=%errorlevel%"',
    "if defined ace_cp chcp %ace_cp% >nul 2>nul",
    "exit /b %ace_status%",
    "",
  ].join("\r\n");
}
