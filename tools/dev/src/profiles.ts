import { join } from "node:path";
import type { ProcessSpec } from "./runner.ts";

/** Ports and directories of the isolated development environment. */
export interface DevLayout {
  repo: string;
  /** `~/.ace/dev/`, shared by every checkout so dev data survives across worktrees. */
  root: string;
  /** ACE_HOME of the development daemon: the root itself, never `~/.ace`. */
  home: string;
  /**
   * Electron's userData in development (window state, sessions, settings). A sibling of the
   * home, never inside it: the daemon treats an unmarked, non-empty home as an old data format.
   */
  electron: string;
  daemonPort: number;
  webPort: number;
}

export const profileNames = ["dev", "dev:web", "dev:fake", "dev:desktop:fake", "daemon"] as const;
export type ProfileName = (typeof profileNames)[number];

export function devLayout(repo: string, env: NodeJS.ProcessEnv, userHome: string): DevLayout {
  const root = env.ACE_DEV_DIR ?? join(userHome, ".ace", "dev");
  return {
    repo,
    root,
    home: root,
    electron: `${root}-electron`,
    daemonPort: Number(env.ACE_DEV_DAEMON_PORT ?? 4343),
    webPort: Number(env.ACE_DEV_WEB_PORT ?? 5173),
  };
}

export function daemonUrl(layout: DevLayout): string {
  return `ws://127.0.0.1:${layout.daemonPort}/`;
}
export function webUrl(layout: DevLayout): string {
  return `http://localhost:${layout.webPort}/`;
}

function daemon(layout: DevLayout): ProcessSpec {
  return {
    name: "daemon",
    // The daemon runs on Bun, as releases ship it. Bun restarts it (SIGTERM, so it shuts down
    // cleanly) when any imported source file changes.
    command: "bun",
    args: ["--watch", "--no-clear-screen", "apps/daemon/src/cli.ts", "start"],
    cwd: layout.repo,
    env: {
      ACE_HOME: layout.home,
      ACE_PORT: String(layout.daemonPort),
      ACE_LISTEN: "local",
      // The dev web app (and the dev desktop renderer, which loads it) manages devices cross-origin.
      ACE_WEB_ORIGINS: new URL(webUrl(layout)).origin,
    },
  };
}

/** Rebuilds the Rust add-on on change; the daemon's watch then restarts it (ADR 0125). */
function native(layout: DevLayout): ProcessSpec {
  return {
    name: "rust",
    command: process.execPath,
    args: ["tools/dev/src/native-watch.ts"],
    cwd: layout.repo,
  };
}

function web(layout: DevLayout, fake: boolean): ProcessSpec {
  return {
    name: fake ? "web:fake" : "web",
    command: "bun",
    args: [
      "x",
      "vite",
      ...(fake ? ["--mode", "fake"] : []),
      "--port",
      `${layout.webPort}`,
      "--strictPort",
    ],
    cwd: join(layout.repo, "apps/web"),
    env: fake ? {} : { VITE_ACE_DAEMON_URL: daemonUrl(layout) },
  };
}

function desktop(layout: DevLayout, fake: boolean): ProcessSpec {
  return {
    name: "desktop",
    command: process.execPath,
    args: ["apps/desktop/scripts/dev.ts"],
    cwd: layout.repo,
    env: {
      ACE_DESKTOP_RENDERER_URL: webUrl(layout),
      ACE_DESKTOP_DAEMON: fake ? "fake" : "attach",
      ACE_HOME: layout.home,
      ACE_DESKTOP_USER_DATA: layout.electron,
    },
  };
}

/** The processes each `bun run` development command starts. */
export function profile(name: ProfileName, layout: DevLayout): ProcessSpec[] {
  switch (name) {
    case "daemon":
      return [daemon(layout), native(layout)];
    case "dev:web":
      return [daemon(layout), native(layout), web(layout, false)];
    case "dev":
      return [daemon(layout), native(layout), web(layout, false), desktop(layout, false)];
    case "dev:fake":
      return [web(layout, true)];
    case "dev:desktop:fake":
      return [web(layout, true), desktop(layout, true)];
  }
}

/** Whether the profile runs the development daemon (and so may be seeded). */
export function usesDaemon(name: ProfileName): boolean {
  return name === "daemon" || name === "dev" || name === "dev:web";
}
