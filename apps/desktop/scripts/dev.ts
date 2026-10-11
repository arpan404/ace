#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { context, type Plugin } from "esbuild";
import { appEnvironment, desktop, electronBinary, electronBundles, mainEntry } from "./common.ts";

/**
 * `bun run dev` / `dev:desktop:fake` (through tools/dev): bundles main and preload in watch
 * mode and runs Electron against the Vite dev server. The renderer hot-reloads through Vite;
 * a main or preload change restarts Electron.
 */
const outdir = join(desktop, "dist/dev");
const binary = await electronBinary();
let child: ChildProcess | undefined;
let stopping = false;
let restarting: Promise<void> | undefined;
const retiring = new Set<ChildProcess>();
let restartTimer: ReturnType<typeof setTimeout> | undefined;

function launch(): void {
  child = spawn(binary, [join(outdir, mainEntry)], {
    stdio: "inherit",
    env: { ...appEnvironment(process.env), ELECTRON_ENABLE_LOGGING: "1" },
  });
  const current = child;
  current.once("exit", (code) => {
    if (child !== current) return;
    child = undefined;
    // Closing the window in development ends the session, like quitting the app.
    if (!stopping && !retiring.has(current)) void shutdown(code ?? 0);
  });
}

/** Keep the retiring process owned, with a bounded graceful shutdown. */
async function stopChild(previous: ChildProcess): Promise<void> {
  if (previous.exitCode !== null || previous.signalCode !== null) return;
  retiring.add(previous);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    previous.once("exit", resolve);
    previous.once("error", resolve);
    previous.kill("SIGTERM");
    timer = setTimeout(() => {
      previous.kill("SIGKILL");
      // SIGKILL cannot be ignored; bound even a missing exit notification.
      clearTimeout(timer);
      timer = setTimeout(resolve, 1_000);
    }, 5_000);
  });
  clearTimeout(timer);
  retiring.delete(previous);
  if (child === previous) child = undefined;
}

function restart(): Promise<void> {
  // Builds arriving while the old child exits are all included in the replacement bundle.
  if (restarting) return restarting;
  restarting = (async () => {
    const previous = child;
    if (previous) await stopChild(previous);
    if (!stopping) launch();
  })().finally(() => {
    restarting = undefined;
  });
  return restarting;
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
  electronBundles(outdir, process.env).map((options) =>
    context({ ...options, plugins: [...(options.plugins ?? []), watch] }),
  ),
);
await Promise.all(contexts.map((build) => build.watch()));

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  await Promise.all(contexts.map((build) => build.dispose()));
  await restarting;
  if (child) await stopChild(child);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
