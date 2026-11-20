import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { onTestFinished } from "vitest";
import { z } from "zod";

/*
 * What the sandboxed-page isolation tests share (ADR 0077, ADR 0200 §5.2): a local server that
 * counts what reaches it, the resolver lookups in Chromium's NetLog, and a real Electron running a
 * harness written as a string, bundled beside this folder so it imports the app's own modules.
 */

const electron: unknown = createRequire(import.meta.url)("electron");

export const headless =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

/** Listens on a free loopback port, closed when the test ends. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  onTestFinished(() =>
    new Promise<void>((resolve) => server.close(() => resolve())).then(() => undefined),
  );
  return `http://127.0.0.1:${address.port}`;
}

/** Resolver lookups from Chromium's NetLog, including DNS-only hints with no HTTP request. */
export async function lookups(path: string): Promise<string[]> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("NetLog too large");
  const log = z
    .object({
      constants: z.object({ logEventTypes: z.record(z.string(), z.number()) }),
      events: z.array(
        z.object({ type: z.number(), params: z.record(z.string(), z.unknown()).optional() }),
      ),
    })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const resolver = new Set(
    Object.entries(log.constants.logEventTypes)
      .filter(([name]) => name.startsWith("HOST_RESOLVER"))
      .map(([, value]) => value),
  );
  return log.events.flatMap((event) => {
    const host = event.params?.host ?? event.params?.hostname;
    return resolver.has(event.type) && typeof host === "string" ? [host] : [];
  });
}

/**
 * Bundles `harness` (resolved from `here`), runs it in Electron with `config` as its last
 * argument, and returns once it exits 0. The harness writes its result where the config says.
 */
export async function runElectron(
  harness: string,
  here: string,
  root: string,
  config: Record<string, unknown>,
  label: string,
): Promise<void> {
  if (typeof electron !== "string") throw new Error("Electron binary not installed");
  const main = join(root, "main.cjs");
  await build({
    stdin: { contents: harness, resolveDir: here, loader: "ts", sourcefile: "harness.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: main,
    logLevel: "silent",
  });
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [main, `--user-data-dir=${join(root, "profile")}`, path], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Electron (${label}) did not finish:\n${output}`)),
      60_000,
    );
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.once("error", reject);
  });
  if (code !== 0) throw new Error(`Electron (${label}) exited with ${code}:\n${output}`);
}
