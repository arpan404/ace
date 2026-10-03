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
      define: {
        ACE_RELEASE_PUBLIC_KEY: JSON.stringify(releasePublicKey(env)),
        ACE_APP_VERSION: JSON.stringify(env.ACE_VERSION ?? appVersion()),
      },
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

/** The desktop app's version (`apps/desktop/package.json`). */
export function appVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  if (
    typeof manifest !== "object" ||
    !manifest ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("Cannot read the desktop version");
  return manifest.version;
}

export function electronVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    !manifest ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("Cannot read the installed Electron version");
  return manifest.version;
}

/** The Electron binary from the `electron` package (it exports the path). */
export async function electronBinary(): Promise<string> {
  const { createRequire } = await import("node:module");
  const path: unknown = createRequire(join(desktop, "package.json"))("electron");
  if (typeof path !== "string")
    throw new Error("The electron package did not return a binary path");
  return path;
}

/**
 * The environment for launching the Electron app. An inherited ELECTRON_RUN_AS_NODE (set by
 * Electron-based tools and terminals) would start Electron as plain Node instead.
 */
export function appEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}

/**
 * The architecture a build targets: `--arch arm64|x64`, or this machine's. Native code is
 * built for the host, so the build scripts refuse any other.
 */
export function targetArch(argv: readonly string[]): "arm64" | "x64" {
  const index = argv.indexOf("--arch");
  const value = index === -1 ? process.arch : argv[index + 1];
  if (value !== "arm64" && value !== "x64")
    throw new Error(`Unsupported architecture ${String(value)}: use --arch arm64 or --arch x64`);
  return value;
}
