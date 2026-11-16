import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
const Package = z.object({
  name: z
    .string()
    .regex(/^[@a-zA-Z0-9/_.-]+$/)
    .max(160)
    .optional(),
});

/** Where the bundled dependencies' license texts are written, in one file. */
export const thirdPartyLicensesFile = "THIRD-PARTY-LICENSES";

/**
 * Copy license text, never dependency implementation, into the distribution.
 *
 * Every text goes into one file under a heading naming its package and file. One file per
 * notice made dozens of archive entries, and installed updaters refuse an archive over their
 * entry budget (`releaseArchiveLimits` in `@ace/service`).
 */
export async function collectLicenses(inputs: string[], output: string): Promise<void> {
  if (inputs.length > 4096) throw new Error("Bundle input limit exceeded");
  const packages = new Set<string>();
  const notices: { heading: string; text: string }[] = [];
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
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && /^(?:licen[cs]e|notice|copying)(?:[-.]|$)/i.test(file.name))
          notices.push({
            heading: `${pkg.name} (${file.name})`,
            text: (await readFile(join(directory, file.name), "utf8")).trimEnd(),
          });
      }
      break;
    }
  }
  const body = notices
    .toSorted((a, b) => (a.heading < b.heading ? -1 : a.heading > b.heading ? 1 : 0))
    .map(({ heading, text }) => `${"=".repeat(78)}\n${heading}\n${"=".repeat(78)}\n\n${text}\n`)
    .join("\n");
  await writeFile(join(output, thirdPartyLicensesFile), body);
}
