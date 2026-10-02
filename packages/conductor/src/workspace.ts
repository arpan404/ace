import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Probe on the workspace volume, then inject a pure lookup into Environment.
 * No platform guessing or provider execution. The temporary probe is removed. */
export async function probeOwnershipCase(root: string): Promise<"sensitive" | "insensitive"> {
  const directory = await mkdtemp(join(root, ".ace-conductor-case-"));
  try {
    const original = join(directory, "case-probe");
    await writeFile(original, "case probe", { flag: "wx" });
    try {
      const [lower, upper] = await Promise.all([
        stat(original),
        stat(join(directory, "CASE-PROBE")),
      ]);
      return lower.dev === upper.dev && lower.ino === upper.ino ? "insensitive" : "sensitive";
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return "sensitive";
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
