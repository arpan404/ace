import { join } from "node:path";
import type { ProcessSpec } from "./runner.ts";

/** Ports and directories of the isolated development environment. */
export interface DevLayout {
  repo: string;
  /** `.ace-dev/`: git-ignored, never `~/.ace`. */
  root: string;
  /** ACE_HOME of the development daemon. */
  home: string;
  /** Electron's userData in development (window state, sessions, settings). */
  electron: string;
  daemonPort: number;
  webPort: number;
}

export const profileNames = ["dev", "dev:web", "dev:fake", "dev:desktop:fake", "daemon"] as const;
export type ProfileName = (typeof profileNames)[number];

export function devLayout(repo: string, env: NodeJS.ProcessEnv): DevLayout {
  const root = env.ACE_DEV_DIR ?? join(repo, ".ace-dev");
  return {
    repo,
    root,
    home: join(root, "home"),
    electron: join(root, "electron"),
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
    command: process.execPath,
    // Node restarts the daemon when any imported source file changes.
    args: ["--watch", "--watch-preserve-output", "apps/daemon/src/cli.ts", "start"],
    cwd: layout.repo,
    env: {
      ACE_HOME: layout.home,
      ACE_PORT: String(layout.daemonPort),
      ACE_LISTEN: "local",
    },
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
      return [daemon(layout)];
    case "dev:web":
      return [daemon(layout), web(layout, false)];
    case "dev":
      return [daemon(layout), web(layout, false), desktop(layout, false)];
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
