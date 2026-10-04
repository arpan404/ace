import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BuildOptions } from "esbuild";
import { zodEnglishOnly } from "./zod-english.ts";

export const desktop = resolve(import.meta.dirname, "..");
export const repo = resolve(desktop, "../..");
export const dist = join(desktop, "dist");

/** The release authority's public key, when building a signed release (ADR 0041). */
export function releasePublicKey(env: NodeJS.ProcessEnv): string {
  const path = env.ACE_RELEASE_PUBLIC_KEY_FILE;
  // Unsigned local builds keep the placeholder, so update checks fail closed.
  return path ? readFileSync(path, "utf8") : "__ACE_RELEASE_PUBLIC_KEY__";
}

/**
 * Main and preload bundles. The renderer is the web app's own Vite build.
 *
 * Main is ESM with code splitting (`main.mjs` plus `chunks/`): what the first window needs
 * loads at startup, and the daemon link, the embedded browser and the updater load when first
 * used, while shared code (zod, protocol schemas) stays in shared, tree-shaken chunks. A
 * single CommonJS file cannot do that: esbuild wraps any module that is also imported
 * lazily, so the whole protocol index would run at startup. The sandboxed preload must stay
 * CommonJS.
 *
 * Both are minified: V8 keeps every script's source in memory for lazy compilation, and the
 * preload is parsed again by every page load. Linked source maps keep them debuggable;
 * nothing in the app reads function or class names.
 */
export function electronBundles(outdir: string, env: NodeJS.ProcessEnv): BuildOptions[] {
  const shared: BuildOptions = {
    bundle: true,
    minify: true,
    sourcemap: "linked",
    external: ["electron"],
    plugins: [zodEnglishOnly],
    logLevel: "warning",
    legalComments: "eof",
  };
  return [
    {
      ...shared,
      entryPoints: { main: join(desktop, "src/main/index.ts") },
      outdir,
      format: "esm",
      splitting: true,
      entryNames: "[name]",
      chunkNames: "chunks/[name]-[hash]",
      outExtension: { ".js": ".mjs" },
      platform: "node",
      target: "node24",
      // CommonJS dependencies bundled into ESM still call `require` for Node built-ins.
      banner: {
        js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
      },
      define: {
        ACE_RELEASE_PUBLIC_KEY: JSON.stringify(releasePublicKey(env)),
        ACE_APP_VERSION: JSON.stringify(env.ACE_VERSION ?? appVersion()),
      },
    },
    {
      ...shared,
      entryPoints: [join(desktop, "src/preload/index.ts")],
      outfile: join(outdir, "preload.cjs"),
      format: "cjs",
      // Sandboxed preloads get `require("electron")` and browser globals only.
      platform: "browser",
      target: "chrome140",
    },
  ];
}

/** The main-process entry `electronBundles` writes into its output directory. */
export const mainEntry = "main.mjs";

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
