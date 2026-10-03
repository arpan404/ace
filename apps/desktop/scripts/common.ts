import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BuildOptions } from "esbuild";

export const desktop = resolve(import.meta.dirname, "..");
export const repo = resolve(desktop, "../..");
export const dist = join(desktop, "dist");

/** The release authority's public key, when building a signed release (ADR 0041). */
export function releasePublicKey(env: NodeJS.ProcessEnv): string {
  const path = env.ACE_RELEASE_PUBLIC_KEY_FILE;
  // Unsigned local builds keep the placeholder, so update checks fail closed.
  return path ? readFileSync(path, "utf8") : "__ACE_RELEASE_PUBLIC_KEY__";
}

/** Main and preload bundles. The renderer is the web app's own Vite build. */
export function electronBundles(outdir: string, env: NodeJS.ProcessEnv): BuildOptions[] {
  const shared: BuildOptions = {
    bundle: true,
    format: "cjs",
    sourcemap: "linked",
    external: ["electron"],
    logLevel: "warning",
    legalComments: "eof",
  };
  return [
    {
      ...shared,
      entryPoints: [join(desktop, "src/main/index.ts")],
      outfile: join(outdir, "main.cjs"),
      platform: "node",
      target: "node24",
      define: { __ACE_RELEASE_PUBLIC_KEY__: JSON.stringify(releasePublicKey(env)) },
    },
    {
      ...shared,
      entryPoints: [join(desktop, "src/preload/index.ts")],
      outfile: join(outdir, "preload.cjs"),
      // Sandboxed preloads get `require("electron")` and browser globals only.
      platform: "browser",
      target: "chrome140",
    },
  ];
}

export function electronVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || !manifest || !("version" in manifest) || typeof manifest.version !== "string")
    throw new Error("Cannot read the installed Electron version");
  return manifest.version;
}

/** The Electron binary from the `electron` package (it exports the path). */
export async function electronBinary(): Promise<string> {
  const { createRequire } = await import("node:module");
  const path: unknown = createRequire(join(desktop, "package.json"))("electron");
  if (typeof path !== "string") throw new Error("The electron package did not return a binary path");
  return path;
}
