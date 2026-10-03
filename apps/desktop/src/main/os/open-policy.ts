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

/** What the filesystem says about the resolved path. */
export type PathKind =
  | { type: "file" }
  /** `package`: macOS treats it as one item (an app, installer, plug-in or document). */
  | { type: "directory"; package: boolean };

export function defaultOpenAction(
  path: string,
  kind: PathKind,
  platform: NodeJS.Platform,
): OpenAction {
  const extension = extname(path).toLowerCase();
  // Only a plain folder opens. Anything macOS may treat as a package is revealed: those
  // marked as one, and any folder with an extension, since LaunchServices decides which
  // extensions are packages (`.app`, `.pkg`, `.action`, `.scptd` and many more).
  if (kind.type === "directory") return !kind.package && extension === "" ? "open" : "reveal";
  if (documents.has(extension)) return "open";
  if (platform !== "win32" && scriptsOutsideWindows.has(extension)) return "open";
  return "reveal";
}
