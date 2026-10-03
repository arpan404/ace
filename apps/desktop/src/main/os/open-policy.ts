import { extname } from "node:path";

/**
 * What "open" may do with a path through the OS's default handler. Opening runs whatever
 * the OS associates with it: an app bundle launches, a `.command` runs in Terminal, a `.js`
 * or `.py` runs under Windows Script Host or the Python launcher. So this is an allowlist:
 * plain folders and text, data and source files open; everything else is revealed in the
 * file manager instead. Callers pass the resolved path, so a symlink named `notes.md` that
 * points at an app is judged by its target.
 */
export type OpenAction = "open" | "reveal";

/** Directories that macOS (and some tools) treat as a single launchable item. */
const bundles = new Set([
  ".app",
  ".appex",
  ".bundle",
  ".framework",
  ".kext",
  ".mpkg",
  ".pkg",
  ".plugin",
  ".prefpane",
  ".qlgenerator",
  ".saver",
  ".service",
  ".workflow",
  ".xpc",
]);

/** Text, data and source files no OS runs by default. */
const documents = new Set(
  `md markdown mdx txt text log rst adoc json jsonc json5 jsonl yaml yml toml ini cfg conf env
   csv tsv lock diff patch sql graphql gql proto prisma ts tsx mts cts jsx css scss sass less
   vue svelte astro go rs c h cc cpp hpp cxx m mm swift kt kts java scala cs fs zig dart ex
   exs erl hs ml tf hcl gradle xml svg png jpg jpeg gif webp pdf`
    .split(/\s+/)
    .map((extension) => `.${extension}`),
);

/** Script types that are only documents where no default handler runs them. */
const scriptsOutsideWindows = new Set([".js", ".mjs", ".cjs"]);

export function defaultOpenAction(
  path: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
): OpenAction {
  const extension = extname(path).toLowerCase();
  if (isDirectory) return bundles.has(extension) ? "reveal" : "open";
  if (documents.has(extension)) return "open";
  if (platform !== "win32" && scriptsOutsideWindows.has(extension)) return "open";
  return "reveal";
}
