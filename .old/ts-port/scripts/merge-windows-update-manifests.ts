import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface WindowsUpdateFile {
  readonly url: string;
  readonly sha512: string;
  readonly size?: number;
  readonly blockMapSize?: number;
  readonly isAdminRightsRequired?: boolean;
}

interface WindowsPackageFile extends Omit<WindowsUpdateFile, "url"> {
  readonly path: string;
}

type WindowsUpdateScalar = string | number | boolean;

interface WindowsUpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<WindowsUpdateFile>;
  readonly path: string;
  readonly sha512: string;
  readonly sha2?: string;
  readonly packages: Readonly<Record<string, WindowsPackageFile>>;
  readonly extras: Readonly<Record<string, WindowsUpdateScalar>>;
}

interface MutableWindowsUpdateFile {
  url?: string;
  sha512?: string;
  size?: number;
  blockMapSize?: number;
  isAdminRightsRequired?: boolean;
}

interface MutableWindowsPackageFile {
  path?: string;
  sha512?: string;
  size?: number;
  blockMapSize?: number;
  isAdminRightsRequired?: boolean;
}

function stripSingleQuotes(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseScalarValue(rawValue: string): WindowsUpdateScalar {
  const trimmed = rawValue.trim();
  const isQuoted = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
  const value = isQuoted ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
  if (isQuoted) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseNumberField(
  target: MutableWindowsUpdateFile | MutableWindowsPackageFile,
  key: "size" | "blockMapSize",
  rawValue: string,
  sourcePath: string,
  lineNumber: number,
): void {
  const value = parseScalarValue(rawValue);
  if (typeof value !== "number") {
    throw new Error(
      `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: '${key}' must be a number.`,
    );
  }
  target[key] = value;
}

function parseBooleanField(
  target: MutableWindowsUpdateFile | MutableWindowsPackageFile,
  key: "isAdminRightsRequired",
  rawValue: string,
  sourcePath: string,
  lineNumber: number,
): void {
  const value = parseScalarValue(rawValue);
  if (typeof value !== "boolean") {
    throw new Error(
      `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: '${key}' must be a boolean.`,
    );
  }
  target[key] = value;
}

function finalizeFileRecord(
  currentFile: MutableWindowsUpdateFile | null,
  sourcePath: string,
  lineNumber: number,
): WindowsUpdateFile | null {
  if (currentFile === null) return null;
  if (typeof currentFile.url !== "string" || typeof currentFile.sha512 !== "string") {
    throw new Error(
      `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`,
    );
  }
  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    ...(typeof currentFile.size === "number" ? { size: currentFile.size } : {}),
    ...(typeof currentFile.blockMapSize === "number"
      ? { blockMapSize: currentFile.blockMapSize }
      : {}),
    ...(typeof currentFile.isAdminRightsRequired === "boolean"
      ? { isAdminRightsRequired: currentFile.isAdminRightsRequired }
      : {}),
  };
}

function finalizePackageRecord(
  currentPackage: MutableWindowsPackageFile | null,
  packageArch: string | null,
  sourcePath: string,
  lineNumber: number,
): { arch: string; record: WindowsPackageFile } | null {
  if (currentPackage === null || packageArch === null) return null;
  if (typeof currentPackage.path !== "string" || typeof currentPackage.sha512 !== "string") {
    throw new Error(
      `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: incomplete package entry for '${packageArch}'.`,
    );
  }
  return {
    arch: packageArch,
    record: {
      path: currentPackage.path,
      sha512: currentPackage.sha512,
      ...(typeof currentPackage.size === "number" ? { size: currentPackage.size } : {}),
      ...(typeof currentPackage.blockMapSize === "number"
        ? { blockMapSize: currentPackage.blockMapSize }
        : {}),
      ...(typeof currentPackage.isAdminRightsRequired === "boolean"
        ? { isAdminRightsRequired: currentPackage.isAdminRightsRequired }
        : {}),
    },
  };
}

export function parseWindowsUpdateManifest(raw: string, sourcePath: string): WindowsUpdateManifest {
  const lines = raw.split(/\r?\n/);
  const files: WindowsUpdateFile[] = [];
  const packages: Record<string, WindowsPackageFile> = {};
  const extras: Record<string, WindowsUpdateScalar> = {};
  let version: string | null = null;
  let releaseDate: string | null = null;
  let path: string | null = null;
  let sha512: string | null = null;
  let sha2: string | undefined;
  let inFiles = false;
  let inPackages = false;
  let currentFile: MutableWindowsUpdateFile | null = null;
  let currentPackage: MutableWindowsPackageFile | null = null;
  let currentPackageArch: string | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      const finalized = finalizeFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) };
      inFiles = true;
      inPackages = false;
      continue;
    }

    if (currentFile !== null) {
      const fileShaMatch = line.match(/^    sha512:\s*(.+)$/);
      if (fileShaMatch?.[1]) {
        currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim());
        continue;
      }

      const fileSizeMatch = line.match(/^    size:\s*(.+)$/);
      if (fileSizeMatch?.[1]) {
        parseNumberField(currentFile, "size", fileSizeMatch[1], sourcePath, lineNumber);
        continue;
      }

      const fileBlockMapSizeMatch = line.match(/^    blockMapSize:\s*(.+)$/);
      if (fileBlockMapSizeMatch?.[1]) {
        parseNumberField(
          currentFile,
          "blockMapSize",
          fileBlockMapSizeMatch[1],
          sourcePath,
          lineNumber,
        );
        continue;
      }

      const fileAdminMatch = line.match(/^    isAdminRightsRequired:\s*(.+)$/);
      if (fileAdminMatch?.[1]) {
        parseBooleanField(
          currentFile,
          "isAdminRightsRequired",
          fileAdminMatch[1],
          sourcePath,
          lineNumber,
        );
        continue;
      }
    }

    if (line === "files:") {
      inFiles = true;
      inPackages = false;
      continue;
    }

    if (line === "packages:") {
      const finalizedFile = finalizeFileRecord(currentFile, sourcePath, lineNumber);
      if (finalizedFile) files.push(finalizedFile);
      currentFile = null;
      inFiles = false;
      inPackages = true;
      continue;
    }

    if (inPackages) {
      const packageArchMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (packageArchMatch?.[1]) {
        const finalizedPackage = finalizePackageRecord(
          currentPackage,
          currentPackageArch,
          sourcePath,
          lineNumber,
        );
        if (finalizedPackage) {
          packages[finalizedPackage.arch] = finalizedPackage.record;
        }
        currentPackage = {};
        currentPackageArch = packageArchMatch[1];
        continue;
      }

      if (currentPackage !== null) {
        const packagePathMatch = line.match(/^    path:\s*(.+)$/);
        if (packagePathMatch?.[1]) {
          currentPackage.path = stripSingleQuotes(packagePathMatch[1].trim());
          continue;
        }

        const packageShaMatch = line.match(/^    sha512:\s*(.+)$/);
        if (packageShaMatch?.[1]) {
          currentPackage.sha512 = stripSingleQuotes(packageShaMatch[1].trim());
          continue;
        }

        const packageSizeMatch = line.match(/^    size:\s*(.+)$/);
        if (packageSizeMatch?.[1]) {
          parseNumberField(currentPackage, "size", packageSizeMatch[1], sourcePath, lineNumber);
          continue;
        }

        const packageBlockMapSizeMatch = line.match(/^    blockMapSize:\s*(.+)$/);
        if (packageBlockMapSizeMatch?.[1]) {
          parseNumberField(
            currentPackage,
            "blockMapSize",
            packageBlockMapSizeMatch[1],
            sourcePath,
            lineNumber,
          );
          continue;
        }

        const packageAdminMatch = line.match(/^    isAdminRightsRequired:\s*(.+)$/);
        if (packageAdminMatch?.[1]) {
          parseBooleanField(
            currentPackage,
            "isAdminRightsRequired",
            packageAdminMatch[1],
            sourcePath,
            lineNumber,
          );
          continue;
        }
      }
    }

    if (inFiles && currentFile !== null) {
      const finalized = finalizeFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    if (inPackages && currentPackage !== null && currentPackageArch !== null) {
      const finalizedPackage = finalizePackageRecord(
        currentPackage,
        currentPackageArch,
        sourcePath,
        lineNumber,
      );
      if (finalizedPackage) {
        packages[finalizedPackage.arch] = finalizedPackage.record;
      }
      currentPackage = null;
      currentPackageArch = null;
    }
    inFiles = false;
    inPackages = false;

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new Error(
        `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`,
      );
    }

    const [, key, rawValue] = topLevelMatch;
    const value = parseScalarValue(rawValue);

    if (key === "version") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: version must be a string.`,
        );
      }
      version = value;
      continue;
    }

    if (key === "releaseDate") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: releaseDate must be a string.`,
        );
      }
      releaseDate = value;
      continue;
    }

    if (key === "path") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: path must be a string.`,
        );
      }
      path = value;
      continue;
    }

    if (key === "sha512") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: sha512 must be a string.`,
        );
      }
      sha512 = value;
      continue;
    }

    if (key === "sha2") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid Windows update manifest at ${sourcePath}:${lineNumber}: sha2 must be a string.`,
        );
      }
      sha2 = value;
      continue;
    }

    extras[key] = value;
  }

  const finalizedFile = finalizeFileRecord(currentFile, sourcePath, lines.length);
  if (finalizedFile) files.push(finalizedFile);
  const finalizedPackage = finalizePackageRecord(
    currentPackage,
    currentPackageArch,
    sourcePath,
    lines.length,
  );
  if (finalizedPackage) {
    packages[finalizedPackage.arch] = finalizedPackage.record;
  }

  if (!version) {
    throw new Error(`Invalid Windows update manifest at ${sourcePath}: missing version.`);
  }
  if (!releaseDate) {
    throw new Error(`Invalid Windows update manifest at ${sourcePath}: missing releaseDate.`);
  }
  if (!path) {
    throw new Error(`Invalid Windows update manifest at ${sourcePath}: missing path.`);
  }
  if (!sha512) {
    throw new Error(`Invalid Windows update manifest at ${sourcePath}: missing sha512.`);
  }
  if (files.length === 0) {
    throw new Error(`Invalid Windows update manifest at ${sourcePath}: missing files.`);
  }

  return {
    version,
    releaseDate,
    files,
    path,
    sha512,
    packages,
    extras,
    ...(sha2 !== undefined ? { sha2 } : {}),
  };
}

function mergeExtras(
  primary: Readonly<Record<string, WindowsUpdateScalar>>,
  secondary: Readonly<Record<string, WindowsUpdateScalar>>,
): Record<string, WindowsUpdateScalar> {
  const merged: Record<string, WindowsUpdateScalar> = { ...primary };

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Cannot merge Windows update manifests: conflicting '${key}' values ('${existing}' vs '${value}').`,
      );
    }
    merged[key] = value;
  }

  return merged;
}

function packageFilesEqual(left: WindowsPackageFile, right: WindowsPackageFile): boolean {
  return (
    left.path === right.path &&
    left.sha512 === right.sha512 &&
    left.size === right.size &&
    left.blockMapSize === right.blockMapSize &&
    left.isAdminRightsRequired === right.isAdminRightsRequired
  );
}

export function mergeWindowsUpdateManifests(
  primary: WindowsUpdateManifest,
  secondary: WindowsUpdateManifest,
): WindowsUpdateManifest {
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge Windows update manifests with different versions (${primary.version} vs ${secondary.version}).`,
    );
  }

  const filesByUrl = new Map<string, WindowsUpdateFile>();
  for (const file of [...primary.files, ...secondary.files]) {
    const existing = filesByUrl.get(file.url);
    if (
      existing &&
      (existing.sha512 !== file.sha512 ||
        existing.size !== file.size ||
        existing.blockMapSize !== file.blockMapSize ||
        existing.isAdminRightsRequired !== file.isAdminRightsRequired)
    ) {
      throw new Error(
        `Cannot merge Windows update manifests: conflicting file entry for ${file.url}.`,
      );
    }
    filesByUrl.set(file.url, file);
  }

  const packages: Record<string, WindowsPackageFile> = { ...primary.packages };
  for (const [arch, file] of Object.entries(secondary.packages)) {
    const existing = packages[arch];
    if (existing && !packageFilesEqual(existing, file)) {
      throw new Error(
        `Cannot merge Windows update manifests: conflicting package entry for '${arch}'.`,
      );
    }
    packages[arch] = file;
  }

  const sha2 = primary.sha2 ?? secondary.sha2;
  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()],
    path: primary.path,
    sha512: primary.sha512,
    packages,
    extras: mergeExtras(primary.extras, secondary.extras),
    ...(sha2 !== undefined ? { sha2 } : {}),
  };
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function serializeScalarValue(value: WindowsUpdateScalar): string {
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

function pushOptionalFileFields(
  lines: string[],
  file: Pick<WindowsUpdateFile, "size" | "blockMapSize" | "isAdminRightsRequired">,
): void {
  if (typeof file.size === "number") lines.push(`    size: ${file.size}`);
  if (typeof file.blockMapSize === "number") lines.push(`    blockMapSize: ${file.blockMapSize}`);
  if (typeof file.isAdminRightsRequired === "boolean") {
    lines.push(`    isAdminRightsRequired: ${file.isAdminRightsRequired}`);
  }
}

export function serializeWindowsUpdateManifest(manifest: WindowsUpdateManifest): string {
  const lines = [`version: ${manifest.version}`, "files:"];

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    pushOptionalFileFields(lines, file);
  }

  if (Object.keys(manifest.packages).length > 0) {
    lines.push("packages:");
    for (const [arch, file] of Object.entries(manifest.packages)) {
      lines.push(`  ${arch}:`);
      lines.push(`    path: ${file.path}`);
      lines.push(`    sha512: ${file.sha512}`);
      pushOptionalFileFields(lines, file);
    }
  }

  lines.push(`path: ${manifest.path}`);
  lines.push(`sha512: ${manifest.sha512}`);
  if (manifest.sha2) {
    lines.push(`sha2: ${manifest.sha2}`);
  }

  for (const key of Object.keys(manifest.extras).toSorted()) {
    const value = manifest.extras[key];
    if (value === undefined) {
      throw new Error(`Cannot serialize Windows update manifest: missing value for '${key}'.`);
    }
    lines.push(`${key}: ${serializeScalarValue(value)}`);
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`);
  lines.push("");
  return lines.join("\n");
}

function main(args: ReadonlyArray<string>): void {
  const [x64PathArg, arm64PathArg, outputPathArg] = args;
  if (!x64PathArg || !arm64PathArg) {
    throw new Error(
      "Usage: node scripts/merge-windows-update-manifests.ts <latest.yml> <latest-arm64.yml> [output-path]",
    );
  }

  const x64Path = resolve(x64PathArg);
  const arm64Path = resolve(arm64PathArg);
  const outputPath = resolve(outputPathArg ?? x64PathArg);

  const x64Manifest = parseWindowsUpdateManifest(readFileSync(x64Path, "utf8"), x64Path);
  const arm64Manifest = parseWindowsUpdateManifest(readFileSync(arm64Path, "utf8"), arm64Path);
  const merged = mergeWindowsUpdateManifests(x64Manifest, arm64Manifest);
  writeFileSync(outputPath, serializeWindowsUpdateManifest(merged));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
