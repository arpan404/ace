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
  const chunks = Chunks.parse(JSON.parse(readFileSync(join(out, "worker-bundle.json"), "utf8")));
  const lines = ["\nClient worker analyzer (Rolldown rendered bytes, before minification):"];
  for (const eager of [true, false]) {
    const selected = chunks.filter((chunk) => chunk.eager === eager);
    const modules = selected.flatMap((chunk) => chunk.modules);
    const packages = new Map<string, number>();
    for (const module of modules) {
      const name = module.id.includes("/zod/")
        ? "zod"
        : (module.id.match(/packages\/([^/]+)\//)?.[1] ?? "web / bundler");
      packages.set(name, (packages.get(name) ?? 0) + module.bytes);
    }
    lines.push(eager ? "Eager:" : "Lazy:");
    for (const chunk of selected) {
      const gzip = gzipSync(readFileSync(join(out, chunk.file)), { level: 9 }).length;
      lines.push(`  ${chunk.file}: ${(gzip / 1024).toFixed(3)} KB gzip`);
    }
    for (const [name, bytes] of [...packages].toSorted((a, b) => b[1] - a[1]))
      lines.push(`  ${name}: ${bytes} rendered bytes`);
    for (const module of modules.toSorted((a, b) => b.bytes - a.bytes).slice(0, 15))
      lines.push(`    ${module.bytes.toString().padStart(6)}  ${module.id}`);
  }
  return `${lines.join("\n")}\n`;
}
