import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface MutablePackageJson {
  version?: string;
  [key: string]: unknown;
}

interface SetAppVersionsOptions {
  readonly rootDir?: string;
}

export function setAppVersions(
  version: string,
  options: SetAppVersionsOptions = {},
): { changedFiles: string[] } {
  if (!version.trim()) {
    throw new Error("Version cannot be empty.");
  }

  const rootDir = resolve(options.rootDir ?? process.cwd());
  const appsDir = resolve(rootDir, "apps");
  const appEntries = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));

  const changedFiles: string[] = [];

  for (const appName of appEntries) {
    const relativePath = `apps/${appName}/package.json`;
    const filePath = resolve(rootDir, relativePath);
    const packageJson = JSON.parse(readFileSync(filePath, "utf8")) as MutablePackageJson;

    if (packageJson.version === version) {
      continue;
    }

    packageJson.version = version;
    writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    changedFiles.push(relativePath);
  }

  return { changedFiles };
}

function parseArgs(argv: ReadonlyArray<string>): { version: string; rootDir: string | undefined } {
  let version: string | undefined;
  let rootDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new Error("Only one version can be provided.");
    }
    version = argument;
  }

  if (!version) {
    throw new Error("Usage: bun run set-version <version> [--root <path>]");
  }

  return { version, rootDir };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { version, rootDir } = parseArgs(process.argv.slice(2));
  const { changedFiles } = setAppVersions(version, rootDir === undefined ? {} : { rootDir });

  if (changedFiles.length === 0) {
    console.log(`All app package versions are already set to ${version}.`);
  } else {
    console.log(`Updated ${changedFiles.length} app package version(s) to ${version}.`);
    for (const changedFile of changedFiles) {
      console.log(`- ${changedFile}`);
    }
  }
}
