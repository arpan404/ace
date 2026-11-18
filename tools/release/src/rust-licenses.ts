import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { thirdPartyLicensesFile } from "./licenses.ts";

const CargoMetadata = z.object({
  packages: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      license: z.string().nullable(),
      license_file: z.string().nullable(),
      manifest_path: z.string(),
      source: z.string().nullable(),
      authors: z.array(z.string()),
      repository: z.string().nullable(),
    }),
  ),
  resolve: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        deps: z.array(
          z.object({
            pkg: z.string(),
            dep_kinds: z.array(z.object({ kind: z.string().nullable() })),
          }),
        ),
      }),
    ),
  }),
});

export type ShippedCrate = {
  name: string;
  version: string;
  license: string | null;
  licenseFile: string | null;
  directory: string;
  authors: string[];
  repository: string | null;
};

const crateLimit = 512;
const noticeFile = /^(?:licen[cs]e|notice|copying)(?:[-.]|$)/i;

/**
 * The third-party crates linked into a native binary: everything reachable from its workspace
 * package through normal dependencies in the resolved graph. Dev and build dependencies never
 * ship; workspace crates are ace's own and carry ace's license.
 */
export function shippedCrates(metadata: unknown, packageName: string): ShippedCrate[] {
  const { packages, resolve } = CargoMetadata.parse(metadata);
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(resolve.nodes.map((node) => [node.id, node]));
  const root = packages.find((pkg) => pkg.name === packageName && pkg.source === null);
  if (!root) throw new Error(`${packageName} is missing from its workspace`);
  const pending = [root.id];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    if (visited.size > crateLimit) throw new Error(`${packageName} crate limit exceeded`);
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing resolved crate ${id} for ${packageName}`);
    for (const dep of node.deps)
      if (dep.dep_kinds.some((entry) => entry.kind === null)) pending.push(dep.pkg);
  }
  const shipped: ShippedCrate[] = [];
  for (const id of visited) {
    const pkg = byId.get(id);
    if (!pkg) throw new Error(`Missing crate ${id} for ${packageName}`);
    if (pkg.source === null) continue;
    shipped.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licenseFile: pkg.license_file,
      directory: dirname(pkg.manifest_path),
      authors: pkg.authors,
      repository: pkg.repository,
    });
  }
  return shipped.toSorted((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

async function crateNotices(crate: ShippedCrate): Promise<string[]> {
  const names = new Set(
    (await readdir(crate.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && noticeFile.test(entry.name))
      .map((entry) => entry.name),
  );
  const texts: string[] = [];
  for (const name of [...names].toSorted())
    texts.push(
      `--- ${name} ---\n\n${(await readFile(join(crate.directory, name), "utf8")).trimEnd()}`,
    );
  if (crate.licenseFile && !names.has(crate.licenseFile))
    texts.push(
      `--- ${crate.licenseFile} ---\n\n${(await readFile(join(crate.directory, crate.licenseFile), "utf8")).trimEnd()}`,
    );
  return texts;
}

/**
 * One section per crate: its license expression, authors, source and every notice it ships,
 * under ace's own license for the binary.
 */
export async function licenseListing(
  packageName: string,
  aceLicense: string,
  crates: ShippedCrate[],
): Promise<string> {
  const rule = "=".repeat(78);
  const sections = [`${packageName}: Apache-2.0\n\n${aceLicense.trimEnd()}\n`];
  for (const crate of crates) {
    if (!crate.license && !crate.licenseFile)
      throw new Error(`${crate.name} ${crate.version} declares no license`);
    const header = [
      `${crate.name} ${crate.version}`,
      `License: ${crate.license ?? `see ${crate.licenseFile}`}`,
      ...(crate.authors.length ? [`Authors: ${crate.authors.join(", ")}`] : []),
      ...(crate.repository ? [`Source: ${crate.repository}`] : []),
    ].join("\n");
    const notices = await crateNotices(crate);
    const body = notices.length
      ? notices.join("\n\n")
      : "The crate ships no license file; it is used under the license named above.";
    sections.push(`${rule}\n${header}\n${rule}\n\n${body}\n`);
  }
  return sections.join("\n");
}

/**
 * Writes a native binary's license listing for the crates its `triple` build links, beside the
 * executable (`<workspace>/` on both bundle layouts).
 */
export async function collectRustLicenses(options: {
  repo: string;
  /** The workspace folder under `native/`, e.g. "media" or "files". */
  workspace: string;
  packageName: string;
  triple: string;
  output: string;
}): Promise<void> {
  const { repo, workspace, packageName, triple, output } = options;
  const metadata: unknown = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--filter-platform", triple],
      { cwd: join(repo, "native", workspace), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const listing = await licenseListing(
    packageName,
    await readFile(join(repo, "LICENSE"), "utf8"),
    shippedCrates(metadata, packageName),
  );
  await writeFile(join(output, thirdPartyLicensesFile), listing);
}
