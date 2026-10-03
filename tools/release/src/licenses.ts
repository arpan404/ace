import { readFile, readdir, cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
const Package = z.object({
  name: z
    .string()
    .regex(/^[@a-zA-Z0-9/_.-]+$/)
    .max(160)
    .optional(),
});
/** Copy license text, never dependency implementation, into the distribution. */
export async function collectLicenses(inputs: string[], output: string): Promise<void> {
  if (inputs.length > 4096) throw new Error("Bundle input limit exceeded");
  const packages = new Set<string>();
  await mkdir(join(output, "licenses"));
  for (const input of inputs) {
    if (!input.includes("node_modules")) continue;
    let directory = dirname(resolve(input));
    while (dirname(directory) !== directory) {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        directory = dirname(directory);
        continue;
      }
      const pkg = Package.parse(value);
      if (!pkg.name) {
        directory = dirname(directory);
        continue;
      }
      if (packages.has(directory)) break;
      if (packages.size >= 128) throw new Error("Dependency license limit exceeded");
      packages.add(directory);
      const name = pkg.name.replaceAll("/", "_").replaceAll("@", "");
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && /^(?:licen[cs]e|notice|copying)(?:[-.]|$)/i.test(file.name))
          await cp(join(directory, file.name), join(output, "licenses", `${name}-${file.name}`));
      }
      break;
    }
  }
}
