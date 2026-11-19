import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { inject } from "vitest";
import { electronBundles, repo } from "../../scripts/common.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** The app as the release bundles it, built once per run by `e2e/global-setup.ts`. */
    appBuild: string;
  }
}

/**
 * Main, preload and worker bundles plus the renderer's production build, into `outdir`. The
 * renderer build takes minutes on a loaded machine, so a run builds the app once, before any
 * spec starts (`e2e/global-setup.ts`), never inside a test's time budget.
 */
export async function buildApp(outdir: string): Promise<void> {
  for (const options of electronBundles(outdir, process.env)) await build(options);
  execFileSync(
    "bun",
    ["x", "vite", "build", "--outDir", join(outdir, "renderer"), "--emptyOutDir", "--logLevel", "warn"],
    { cwd: join(repo, "apps/web"), stdio: "inherit", env: { ...process.env, GOMAXPROCS: "1" } },
  );
}

/** Copies the run's app build into `outdir` (a spec's own `Resources/app`). */
export async function copyApp(outdir: string): Promise<void> {
  await cp(inject("appBuild"), outdir, { recursive: true });
}
