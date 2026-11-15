import { execFileSync } from "node:child_process";
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

const CargoPackages = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      dependencies: z.array(z.object({ name: z.string(), source: z.string().nullable() })),
    }),
  ),
});

/** Only crates reachable from the binary ship; other workspace members may have dependencies. */
export function assertMediaNoticeListing(metadata: unknown): void {
  const { packages } = CargoPackages.parse(metadata);
  const pending = ["ace-media"];
  const visited = new Set<string>();
  while (pending.length) {
    const name = pending.pop();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const pkg = packages.find((entry) => entry.name === name);
    if (!pkg) throw new Error(`Missing media workspace dependency ${name}`);
    for (const dependency of pkg.dependencies) {
      if (dependency.source !== null)
        throw new Error(
          "ace-media gained third-party crates: update its license listing before packaging",
        );
      pending.push(dependency.name);
    }
  }
}

/** M0 links no external crates. Fail closed when its reachable dependency graph grows. */
export async function collectMediaLicenses(repo: string, output: string): Promise<void> {
  const metadata: unknown = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], {
      cwd: join(repo, "native/media"),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  assertMediaNoticeListing(metadata);
  await writeFile(
    join(output, thirdPartyLicensesFile),
    "ace-media: Apache-2.0. This build has no third-party crate dependencies.\n\n" +
      (await readFile(join(repo, "LICENSE"), "utf8")),
  );
}
