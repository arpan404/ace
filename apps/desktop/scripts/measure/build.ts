import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { build, type BuildOptions } from "esbuild";
import { desktop, electronBundles, repo } from "../common.ts";

/**
 * Main (through the measurement entry, `entry.ts`) and preload, as `electronBundles` builds
 * them for release. Returns the main bundle's path.
 */
export async function measuredMain(outdir: string): Promise<string> {
  const [main, ...rest] = electronBundles(outdir, process.env);
  if (!main) throw new Error("No main bundle");
  const entry = join(desktop, "scripts/measure/entry.ts");
  const points = main.entryPoints;
  const measured: BuildOptions =
    points && !Array.isArray(points)
      ? { ...main, entryPoints: { ...points, main: entry } }
      : { ...main, entryPoints: [entry] };
  const [result] = await Promise.all([
    build({ ...measured, metafile: true }),
    ...rest.map((options) => build(options)),
  ]);
  const output = Object.entries(result.metafile.outputs).find(
    ([, value]) => value.entryPoint && resolve(value.entryPoint) === entry,
  );
  if (!output) throw new Error("The measurement entry produced no output");
  return resolve(output[0]);
}

/** The web renderer into `<outdir>/renderer`: `production` is the build the app ships. */
export function measuredRenderer(mode: "production" | "fake" | "perf", outdir: string): void {
  execFileSync(
    "bun",
    ["x", "vite", "build", "--mode", mode, "--outDir", join(outdir, "renderer"), "--emptyOutDir"],
    { cwd: join(repo, "apps/web"), stdio: ["ignore", "ignore", "inherit"] },
  );
}
