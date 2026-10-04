import { join } from "node:path";
import { testHomePathVariables } from "@ace/provider-kit/test-isolation";

/** Pure environment policy. The caller owns creation of the redirected directories. */
export function isolatedTestEnvironment(
  ambient: NodeJS.ProcessEnv,
  home: string,
  realHome: string,
): NodeJS.ProcessEnv {
  const selectors = new Set(testHomePathVariables);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      !selectors.has(key) &&
      !/^(?:ACE_|XDG_|GIT_CONFIG|CURSOR_|OPENCODE_)/.test(key) &&
      !["SHELL", "HOMEDRIVE", "HOMEPATH", "NODE_OPTIONS"].includes(key)
    )
      env[key] = value;
  }
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
    ANDROID_USER_HOME: join(home, ".android"),
    ANDROID_AVD_HOME: join(home, ".android/avd"),
    ZDOTDIR: home,
    INPUTRC: join(home, ".inputrc"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_SYSTEM: join(home, ".gitconfig-system"),
    GIT_CONFIG_NOSYSTEM: "1",
    BUN_INSTALL_CACHE_DIR: join(home, ".cache/bun"),
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    ACE_HISTORY_INSTANCES: "[]",
    ACE_MODEL_INSTANCES: "[]",
    ACE_TEST_REAL_HOME: realHome,
  };
}
