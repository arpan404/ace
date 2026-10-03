#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { context, type Plugin } from "esbuild";
import { appEnvironment, desktop, electronBinary, electronBundles } from "./common.ts";

/**
 * `bun run dev` / `dev:desktop:fake` (through tools/dev): bundles main and preload in watch
 * mode and runs Electron against the Vite dev server. The renderer hot-reloads through Vite;
 * a main or preload change restarts Electron.
 */
const outdir = join(desktop, "dist/dev");
const binary = await electronBinary();
let child: ChildProcess | undefined;
let stopping = false;
let restartTimer: ReturnType<typeof setTimeout> | undefined;

function launch(): void {
  child = spawn(binary, [join(outdir, "main.cjs")], {
    stdio: "inherit",
    env: { ...appEnvironment(process.env), ELECTRON_ENABLE_LOGGING: "1" },
  });
  const current = child;
  current.once("exit", (code) => {
    if (child !== current) return;
    child = undefined;
    // Closing the window in development ends the session, like quitting the app.
    if (!stopping) void shutdown(code ?? 0);
  });
}

async function restart(): Promise<void> {
  const previous = child;
  child = undefined;
  if (previous && previous.exitCode === null) {
    const exited = new Promise((resolve) => previous.once("exit", resolve));
    previous.kill("SIGTERM");
    await exited;
  }
  if (!stopping) launch();
}

let built = 0;
const watch: Plugin = {
  name: "restart-electron",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      if (++built <= 2) {
        if (built === 2) launch();
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        console.log("[desktop] main or preload changed; restarting Electron");
        void restart();
      }, 150);
    });
  },
};

const contexts = await Promise.all(
  electronBundles(outdir, process.env).map((options) => context({ ...options, plugins: [watch] })),
);
await Promise.all(contexts.map((build) => build.watch()));

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.all(contexts.map((build) => build.dispose()));
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
