import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Shared by Vitest workers and the process project's fixture-building children. */
export function testHomeEnvironment(home: string, realHome: string): NodeJS.ProcessEnv {
  const directories = {
    ACE_HOME: join(home, ".ace"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
    TMPDIR: join(home, "tmp"),
  };
  for (const directory of Object.values(directories))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    ...directories,
    HOME: home,
    USERPROFILE: home,
    APPDATA: directories.XDG_CONFIG_HOME,
    LOCALAPPDATA: directories.XDG_DATA_HOME,
    XDG_CONFIG_DIRS: directories.XDG_CONFIG_HOME,
    XDG_DATA_DIRS: directories.XDG_DATA_HOME,
    TMP: directories.TMPDIR,
    TEMP: directories.TMPDIR,
    ACE_TEST_REAL_HOME: realHome,
  };
}
