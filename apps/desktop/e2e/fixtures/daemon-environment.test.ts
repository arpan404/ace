import { isAbsolute, join, relative } from "node:path";
import { expect, test } from "vitest";
import {
  desktopDaemonEnvironment,
  desktopDaemonLayout,
  environmentFolders,
} from "./daemon-environment.ts";

const realHome = "/Users/person";
const ambient: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: realHome,
  ACE_HOME: join(realHome, ".ace"),
  ACE_ACCOUNTS_DB: join(realHome, ".ace/accounts.sqlite"),
  XDG_CONFIG_HOME: join(realHome, ".config"),
  XDG_DATA_HOME: join(realHome, ".local/share"),
  CLAUDE_CONFIG_DIR: join(realHome, ".claude"),
  CODEX_HOME: join(realHome, ".codex"),
  TMPDIR: "/var/folders/xy/T",
  GIT_DIR: "/Users/person/Code/ace/.git",
  BUN_OPTIONS: "--preload /Users/person/hook.ts",
  NODE_OPTIONS: "--require /Users/person/hook.cjs",
  ELECTRON_RUN_AS_NODE: "1",
};
const inside = (root: string, path: string) => {
  const difference = relative(root, path);
  return !difference.startsWith("..") && !isAbsolute(difference);
};

test("the desktop daemon's homes and folders all sit inside the spec's root, none inherited", () => {
  const layout = desktopDaemonLayout("/tmp/ace-panel-e2e-1");
  const env = desktopDaemonEnvironment(ambient, layout, realHome);
  expect(env).toMatchObject({ HOME: layout.root, ACE_HOME: join(layout.root, "home") });
  for (const key of [
    "ACE_ACCOUNTS_DB",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GIT_CONFIG_GLOBAL",
    ...environmentFolders,
  ])
    expect(inside(layout.root, env[key] ?? "/"), `${key}=${env[key]}`).toBe(true);
});

test("no runtime flag or Git checkout of the caller's reaches the desktop daemon", () => {
  const env = desktopDaemonEnvironment(ambient, desktopDaemonLayout("/tmp/root"), realHome);
  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "GIT_DIR"])
    expect(env[key], key).toBeUndefined();
  // The tools a person's PATH reaches (git, a browser) stay reachable.
  expect(env.PATH).toBe(ambient.PATH);
});
