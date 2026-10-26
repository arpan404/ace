import { delimiter, dirname, join } from "node:path";
import { testHomePathVariables } from "@ace/provider-kit/test-isolation";

/**
 * Pure environment policy. The caller owns creation of the redirected directories.
 * `gitCeilings` are checkouts a test git must never discover by walking up from its cwd.
 */
export function isolatedTestEnvironment(
  ambient: NodeJS.ProcessEnv,
  home: string,
  realHome: string,
  gitCeilings: readonly string[] = [],
): NodeJS.ProcessEnv {
  const selectors = new Set(testHomePathVariables);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      !selectors.has(key) &&
      // Every GIT_* goes: a GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_INDEX_FILE inherited
      // from a hook or a linked worktree would aim fixture git commands at the real checkout.
      !/^(?:ACE_|XDG_|GIT_|CURSOR_|OPENCODE_)/.test(key) &&
      !["SHELL", "HOMEDRIVE", "HOMEPATH", "NODE_OPTIONS"].includes(key)
    )
      env[key] = value;
  }
  const deviceLive = ambient.ACE_DEVICE_LIVE === "1";
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ACE_HOME: join(home, ".ace"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
    XDG_CONFIG_DIRS: join(home, ".config"),
    XDG_DATA_DIRS: join(home, ".local/share"),
    APPDATA: join(home, ".config"),
    LOCALAPPDATA: join(home, ".local/share"),
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CURSOR_CONFIG_DIR: join(home, ".cursor"),
    CURSOR_DATA_DIR: join(home, ".cursor"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    ANDROID_USER_HOME: deviceLive
      ? (ambient.ANDROID_USER_HOME ?? join(realHome, ".android"))
      : join(home, ".android"),
    ANDROID_AVD_HOME: deviceLive
      ? (ambient.ANDROID_AVD_HOME ?? join(realHome, ".android/avd"))
      : join(home, ".android/avd"),
    ZDOTDIR: home,
    INPUTRC: join(home, ".inputrc"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_SYSTEM: join(home, ".gitconfig-system"),
    GIT_CONFIG_NOSYSTEM: "1",
    // Repository discovery stops at the test home root and at every enclosing checkout.
    GIT_CEILING_DIRECTORIES: [dirname(home), ...gitCeilings].join(delimiter),
    BUN_INSTALL_CACHE_DIR: join(home, ".cache/bun"),
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    ACE_HISTORY_INSTANCES: "[]",
    ACE_MODEL_INSTANCES: "[]",
    ACE_TEST_REAL_HOME: realHome,
    // This flag opts into only the dedicated native fixture, never a user app or home.
    ...(ambient.ACE_SCREEN_INTEGRATION === "1" ? { ACE_SCREEN_INTEGRATION: "1" } : {}),
    // This one lets the computer engine operate Calculator, and only Calculator.
    ...(ambient.ACE_COMPUTER_LIVE === "1" ? { ACE_COMPUTER_LIVE: "1" } : {}),
    ...(ambient.ACE_DEVICE_LIVE === "1" ? { ACE_DEVICE_LIVE: "1" } : {}),
    ...linuxDesktopSession(ambient),
    ...androidDevice(ambient),
    // `bun run eval:mcp` names where the MCP eval harness writes its report.
    ...(ambient.ACE_EVAL_REPORT !== undefined ? { ACE_EVAL_REPORT: ambient.ACE_EVAL_REPORT } : {}),
    ...(ambient.ACE_EVAL_LABEL !== undefined ? { ACE_EVAL_LABEL: ambient.ACE_EVAL_LABEL } : {}),
    ...(ambient.ACE_DEVICE_VIDEO_LIVE === "1" ? { ACE_DEVICE_VIDEO_LIVE: "1" } : {}),
    ...(ambient.ACE_DEVICE_GESTURE_LIVE === "1" ? { ACE_DEVICE_GESTURE_LIVE: "1" } : {}),
    ...(ambient.ACE_DEVICE_LIVE_IOS_UUID !== undefined
      ? { ACE_DEVICE_LIVE_IOS_UUID: ambient.ACE_DEVICE_LIVE_IOS_UUID }
      : {}),
    ...(ambient.ACE_DEVICE_LIVE_ANDROID_AVD !== undefined
      ? { ACE_DEVICE_LIVE_ANDROID_AVD: ambient.ACE_DEVICE_LIVE_ANDROID_AVD }
      : {}),
    ...(ambient.ACE_DEVICE_LIVE_ANDROID_SERIAL !== undefined
      ? { ACE_DEVICE_LIVE_ANDROID_SERIAL: ambient.ACE_DEVICE_LIVE_ANDROID_SERIAL }
      : {}),
    // Browser binaries are installed once per machine; tests drive them read-only. CI installs
    // ace's pinned Chrome and names it in ACE_CHROMIUM_PATH; without it Linux has no browser
    // and every real-Chromium suite would skip.
    ...(ambient.ACE_CHROMIUM_PATH !== undefined
      ? { ACE_CHROMIUM_PATH: ambient.ACE_CHROMIUM_PATH }
      : {}),
    PLAYWRIGHT_BROWSERS_PATH: ambient.PLAYWRIGHT_BROWSERS_PATH ?? playwrightCache(realHome),
  };
}

/**
 * The Linux desktop end-to-end suite (`ACE_LINUX_DESKTOP_E2E`) drives a throwaway desktop the
 * runner script started, never the person's own. Its helper must reach that session: the
 * runtime directory holding the Wayland socket and PipeWire, the system data directories with
 * the apps' desktop files, and the session type. Writable XDG homes stay isolated.
 */
function linuxDesktopSession(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const session = ambient.ACE_LINUX_DESKTOP_E2E;
  if (!session) return {};
  const kept: NodeJS.ProcessEnv = { ACE_LINUX_DESKTOP_E2E: session };
  for (const key of [
    "ACE_SCREEN_HELPER",
    // Where the suite keeps what a viewer received, for a person to look at.
    "ACE_E2E_ARTIFACTS",
    // What reached the live-view suites' fixture window.
    "ACE_E2E_FIXTURE_LOG",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    // Hyprland's and Sway's control sockets, and the file the scripted chooser answers from.
    "HYPRLAND_INSTANCE_SIGNATURE",
    "SWAYSOCK",
    "ACE_E2E_PICKER_CHOICE",
  ] as const) {
    const value = ambient[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * The Android end-to-end suite (`ACE_ANDROID_E2E_SDK`) drives a device its runner booted, through
 * that SDK's adb, or an AVD it asks ace to boot (`ACE_ANDROID_E2E_BOOT_AVD`) from the AVD folder
 * the runner names (`ANDROID_AVD_HOME`, outside the real home: the home guard still applies).
 * Only those are kept; the homes stay isolated.
 */
function androidDevice(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sdk = ambient.ACE_ANDROID_E2E_SDK;
  if (!sdk) return {};
  const kept: NodeJS.ProcessEnv = { ACE_ANDROID_E2E_SDK: sdk };
  for (const key of [
    "ACE_E2E_ARTIFACTS",
    "ACE_ANDROID_E2E_SERIAL",
    "ACE_ANDROID_E2E_BOOT_AVD",
    "ACE_ANDROID_EMULATOR_GPU",
  ]) {
    const value = ambient[key];
    if (value) kept[key] = value;
  }
  if (kept.ACE_ANDROID_E2E_BOOT_AVD && ambient.ANDROID_AVD_HOME)
    kept.ANDROID_AVD_HOME = ambient.ANDROID_AVD_HOME;
  return kept;
}

/** Where Playwright installs its browsers for the real user (its documented default). */
function playwrightCache(realHome: string): string {
  if (process.platform === "darwin") return join(realHome, "Library/Caches/ms-playwright");
  if (process.platform === "win32") return join(realHome, "AppData/Local/ms-playwright");
  return join(realHome, ".cache/ms-playwright");
}
