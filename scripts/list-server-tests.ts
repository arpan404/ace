// SPDX-License-Identifier: Apache-2.0
/**
 * Every test file that starts a daemon server, for the transport's proof run (ADR 0226, T1a.8).
 *
 * The set is found by an import graph over `apps/daemon/src` and `packages/*\/src`: relative
 * imports resolve inside the tree, and workspace package imports resolve through each package's
 * `package.json` `exports`, so a helper that reaches `startServer` through `@ace/daemon` (as
 * `packages/client/src/test-support.ts` does) is found too. The seeds are the non-test modules
 * that call `startServer(`, `startDaemon(` or `startDaemonCli(`, and `socket-test-support.ts`'s
 * `fixture(`. Every non-test module importing one of those joins, repeated to a fixed point, and
 * each test file importing a member - or calling a seed itself - is printed, sorted, one path per
 * line. An import this script can't resolve fails it, naming the import.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The trees the graph covers: the daemon's source and every workspace package's source. */
function sourceRoots(): string[] {
  const roots = [join(root, "apps/daemon/src")];
  for (const name of readdirSync(join(root, "packages"))) {
    const dir = join(root, "packages", name, "src");
    if (existsSync(dir)) roots.push(dir);
  }
  return roots;
}

/** Every TypeScript source under the roots, absolute. */
function sourceFiles(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  for (const start of roots) walk(start);
  return found;
}

/** One workspace package: its name, directory and `exports` map. */
interface Workspace {
  name: string;
  dir: string;
  exports: Record<string, unknown>;
}

function workspaces(): Workspace[] {
  const found: Workspace[] = [];
  for (const group of ["packages", "apps", "tools"]) {
    let names: string[];
    try {
      names = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const entry of names) {
      const manifest = join(root, group, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: unknown;
        exports?: unknown;
      };
      if (typeof parsed.name !== "string") continue;
      const map = parsed.exports;
      if (map === undefined || typeof map !== "object" || map === null) continue;
      found.push({
        name: parsed.name,
        dir: join(root, group, entry),
        exports: map as Record<string, unknown>,
      });
    }
  }
  return found;
}

const packages = workspaces();

/** An export target's file path, or undefined for an unsupported shape. */
function targetPath(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The module a workspace specifier names, through its package's `exports`. */
function resolveWorkspace(specifier: string): string | undefined {
  let match: Workspace | undefined;
  for (const candidate of packages) {
    if (specifier !== candidate.name && !specifier.startsWith(`${candidate.name}/`)) continue;
    if (match === undefined || candidate.name.length > match.name.length) match = candidate;
  }
  if (match === undefined) return undefined;
  const subpath = specifier.slice(match.name.length);
  const key = subpath === "" ? "." : `.${subpath}`;
  const direct = targetPath(match.exports[key]);
  if (direct !== undefined) return resolve(match.dir, direct);
  // One wildcard subpath (`@ace/editor`'s `./pkg/*`): substitute the matched part.
  for (const [pattern, value] of Object.entries(match.exports)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const target = targetPath(value);
    if (target === undefined) continue;
    const captured = key.slice(prefix.length, key.length - suffix.length);
    return resolve(match.dir, target.replace("*", captured));
  }
  return undefined;
}

/** A resolved path with its extension: the file itself, or the TypeScript source it names. */
function asFile(path: string): string | undefined {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
  ];
  if (path.endsWith(".js")) {
    candidates.unshift(path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx");
  }
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith("/"));
}

/**
 * The file's source with comments and template literals blanked, so a string that merely spells
 * an import (a child script held in a template) is not read as one. Newlines stay, so offsets and
 * line structure do not matter to the patterns below.
 */
function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " ";
  };
  for (let index = 0; index < text.length;) {
    const two = text.slice(index, index + 2);
    if (two === "//") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      blank(index, stop);
      index = stop;
    } else if (two === "/*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (text[index] === "'" || text[index] === '"') {
      const quote = text[index];
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== quote) {
        if (text[cursor] === "\\") cursor++;
        else if (text[cursor] === "\n") break;
        cursor++;
      }
      index = cursor + 1;
    } else if (text[index] === "`") {
      let cursor = index + 1;
      let depth = 0;
      while (cursor < text.length) {
        const character = text[cursor];
        if (character === "\\") {
          cursor += 2;
          continue;
        }
        if (depth === 0 && character === "`") break;
        if (character === "$" && text[cursor + 1] === "{") {
          depth++;
          cursor += 2;
          continue;
        }
        if (depth > 0 && character === "}") depth--;
        cursor++;
      }
      blank(index, cursor + 1);
      index = cursor + 1;
    } else {
      index++;
    }
  }
  return out.join("");
}

/** One file's imports, resolved. A relative or workspace import that can't resolve throws. */
function importsOf(file: string, from: string): string[] {
  const text = codeOnly(readFileSync(file, "utf8"));
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g;
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const match of [...text.matchAll(pattern), ...text.matchAll(bare)]) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const path = resolveSpecifier(specifier, from, file);
    if (path !== undefined) found.push(path);
  }
  return found;
}

function resolveSpecifier(specifier: string, from: string, file: string): string | undefined {
  if (specifier.startsWith(".")) {
    const path = asFile(resolve(from, specifier));
    if (path === undefined)
      throw new Error(`${relative(root, file)} imports ${specifier}, which does not resolve`);
    return path;
  }
  if (specifier.startsWith("@ace/")) {
    const target = resolveWorkspace(specifier);
    const path = target === undefined ? undefined : asFile(target);
    if (path === undefined)
      throw new Error(
        `${relative(root, file)} imports ${specifier}, which no workspace package exports`,
      );
    return path;
  }
  // A package outside the workspace (`node:fs`, `ws`, `zod`): nothing to follow.
  return undefined;
}

const SEED_CALL = /\b(?:startServer|startDaemon|startDaemonCli)\s*\(/;
/** `socket-test-support.ts` defines the shared daemon fixture every socket test starts from. */
const FIXTURE_FILE = join(root, "apps/daemon/src/socket-test-support.ts");

/** Whether a non-test module starts a server itself. */
function seedsServer(file: string): boolean {
  if (file === FIXTURE_FILE) return true;
  return SEED_CALL.test(readFileSync(file, "utf8"));
}

/** Whether a file is a test, by its name. */
function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/**
 * Every test file that starts a server, relative to the repository root and sorted. The graph is
 * built once per call, so a proof run sees the tree as it is now.
 */
export function listServerTests(): string[] {
  const files = sourceFiles(sourceRoots());
  const known = new Set(files);
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    for (const target of importsOf(file, dirname(file))) {
      if (!known.has(target)) continue;
      const set = importers.get(target);
      if (set) set.add(file);
      else importers.set(target, new Set([file]));
    }
  }
  const set = new Set<string>();
  for (const file of files) if (!isTest(file) && seedsServer(file)) set.add(file);
  // Helpers of helpers: every non-test module importing one member joins, until nothing changes.
  // New members append to the work queue, so the walk sees each member exactly once.
  const queue = [...set];
  for (let index = 0; index < queue.length; index++) {
    const member = queue[index];
    if (member === undefined) continue;
    for (const importer of importers.get(member) ?? []) {
      if (isTest(importer) || set.has(importer)) continue;
      set.add(importer);
      queue.push(importer);
    }
  }
  const found = new Set<string>();
  for (const file of files) {
    if (!isTest(file)) continue;
    const imports = importsOf(file, dirname(file));
    if (imports.some((target) => set.has(target)) || seedsServer(file)) found.add(file);
  }
  // One spelling across platforms: the proof runner and its result keys compare these paths.
  return [...found].map((file) => relative(root, file).split(sep).join("/")).toSorted();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const file of listServerTests()) console.log(file);
}
