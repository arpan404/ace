import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";

const Chunks = z.array(
  z.object({
    file: z.string(),
    eager: z.boolean(),
    modules: z.array(z.object({ id: z.string(), bytes: z.number().nonnegative() })),
  }),
);

/** Rendered module lengths are before minification; only chunk gzip sizes are additive budgets. */
export function workerBreakdown(out: string): string {
  return ["client-worker", "machine-worker"]
    .map((worker) => bundleBreakdown(out, `${worker}-bundle.json`, worker, 15))
    .join("");
}

export function initialBreakdown(out: string): string {
  return bundleBreakdown(out, "initial-bundle.json", "Initial page", 50);
}

function bundleBreakdown(out: string, file: string, label: string, moduleLimit: number): string {
  const chunks = Chunks.parse(JSON.parse(readFileSync(join(out, file), "utf8")));
  const lines = [`\n${label} analyzer (Rolldown rendered bytes, before minification):`];
  for (const eager of [true, false]) {
    const selected = chunks.filter((chunk) => chunk.eager === eager);
    if (!selected.length) continue;
    const modules = selected.flatMap((chunk) => chunk.modules);
    const packages = new Map<string, number>();
    for (const module of modules) {
      const name = module.id.includes("/zod/")
        ? "zod"
        : (module.id.match(/packages\/([^/]+)\//)?.[1] ??
          module.id
            .match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)
            ?.at(-1)
            ?.replace(/^node_modules\//, "")
            .replace(/\/$/, "") ??
          "web / bundler");
      packages.set(name, (packages.get(name) ?? 0) + module.bytes);
    }
    lines.push(eager ? "Eager:" : "Lazy:");
    for (const chunk of selected) {
      const gzip = gzipSync(readFileSync(join(out, chunk.file)), { level: 9 }).length;
      lines.push(`  ${chunk.file}: ${(gzip / 1024).toFixed(3)} KB gzip`);
    }
    for (const [name, bytes] of [...packages].toSorted((a, b) => b[1] - a[1]))
      lines.push(`  ${name}: ${bytes} rendered bytes`);
    for (const module of modules.toSorted((a, b) => b.bytes - a.bytes).slice(0, moduleLimit))
      lines.push(`    ${module.bytes.toString().padStart(6)}  ${module.id}`);
  }
  return `${lines.join("\n")}\n`;
}
