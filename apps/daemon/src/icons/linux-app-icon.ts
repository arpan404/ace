import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/*
 * A Linux app's icon, as the desktop shows it: the app's desktop entry names its `Icon=`, a
 * file path or a name looked up in the icon themes: hicolor first (every app installs its own
 * icon there), then the others (KDE apps name Breeze icons), and in each the largest PNG of at
 * least 64px, then the SVG, then smaller PNGs; `pixmaps` last. Themes lay sizes out as
 * `<size>/apps/` or `apps/<size>/`. Desktop entries and icons come from the XDG data dirs,
 * Flatpak's exports and Snap's. The icon service makes the bytes safe and small
 * (`installedIconPng`); SVGs pass only without scripts, embedded content or outside references.
 */

/** Reads a file's bytes, or undefined when it can't. Injected for tests. */
export type ReadBytes = (path: string) => Promise<Buffer | undefined>;

/** Desktop ids and icon names: reverse-DNS or plain names, never a path. */
const safeName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
const MAX_BYTES = 2 * 1024 * 1024;

/** Only regular files of a bounded size: an `Icon=` path could name a device or a huge file. */
const readBytes: ReadBytes = async (path) => {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= MAX_BYTES ? await readFile(path) : undefined;
  } catch {
    return undefined;
  }
};

export function dataDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? "";
  const user = env.XDG_DATA_HOME || (home ? join(home, ".local", "share") : "");
  const system = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [
    user,
    ...system,
    home ? join(home, ".local", "share", "flatpak", "exports", "share") : "",
    "/var/lib/flatpak/exports/share",
    "/var/lib/snapd/desktop",
  ].filter((dir, index, all) => dir && isAbsolute(dir) && all.indexOf(dir) === index);
}

/** The `Icon=` of a desktop entry's main group. */
export function desktopIcon(entry: string): string | undefined {
  let main = false;
  for (const raw of entry.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      main = line === "[Desktop Entry]";
      continue;
    }
    if (main && line.startsWith("Icon=")) return line.slice(5).trim() || undefined;
  }
  return undefined;
}

/** A theme's size folder name as pixels: "256x256", "48", "48@2x"; scalable is unbounded. */
export function sizeOf(folder: string): number | undefined {
  if (folder === "scalable") return Number.POSITIVE_INFINITY;
  const match = /^(\d+)(?:x\d+)?(?:@(\d)x)?$/.exec(folder);
  return match ? Number(match[1]) * Number(match[2] ?? 1) : undefined;
}

type Candidate = { path: string; theme: number; size: number; svg: boolean };

/** Best first: by theme, then PNGs of 64px or more (largest), the SVG, then smaller PNGs. */
function rank(a: Candidate, b: Candidate): number {
  const tier = (c: Candidate) => (c.svg ? 1 : c.size >= 64 ? 0 : 2);
  return a.theme - b.theme || tier(a) - tier(b) || b.size - a.size;
}

const list = (dir: string) => readdir(dir).catch((): string[] => []);

/** The icon files to try for an icon name, best first. */
export async function iconCandidates(dirs: readonly string[], name: string): Promise<string[]> {
  const found: Candidate[] = [];
  for (const dir of dirs) {
    const themes = (await list(join(dir, "icons"))).toSorted((a, b) =>
      a === "hicolor" ? -1 : b === "hicolor" ? 1 : a.localeCompare(b),
    );
    for (const theme of themes) {
      const rankOf = theme === "hicolor" ? 0 : 1;
      const root = join(dir, "icons", theme);
      const add = (folder: string, size: number) => {
        if (size !== Number.POSITIVE_INFINITY && size <= 512)
          found.push({ path: join(folder, `${name}.png`), theme: rankOf, size, svg: false });
        found.push({ path: join(folder, `${name}.svg`), theme: rankOf, size, svg: true });
      };
      for (const entry of await list(root)) {
        const size = sizeOf(entry);
        if (size !== undefined) add(join(root, entry, "apps"), size);
        else if (entry === "apps")
          for (const nested of await list(join(root, "apps"))) {
            const inner = sizeOf(nested);
            if (inner !== undefined) add(join(root, "apps", nested), inner);
          }
      }
    }
  }
  const pixmaps = dirs.flatMap((dir) => [
    join(dir, "pixmaps", `${name}.png`),
    join(dir, "pixmaps", `${name}.svg`),
  ]);
  return [...found.toSorted(rank).map((c) => c.path), ...pixmaps];
}

/** The icon's bytes; null when the app or its icon isn't found. */
export async function linuxAppIcon(
  identity: string,
  env: NodeJS.ProcessEnv,
  read: ReadBytes = readBytes,
): Promise<Buffer | null> {
  const id = identity.replace(/\.desktop$/, "");
  if (!safeName.test(id)) return null;
  const dirs = dataDirs(env);
  let icon: string | undefined;
  for (const dir of dirs) {
    const entry = await read(join(dir, "applications", `${id}.desktop`));
    if (entry) {
      icon = desktopIcon(entry.toString("utf8"));
      break;
    }
  }
  if (!icon) return null;
  const candidates = isAbsolute(icon)
    ? [icon]
    : safeName.test(icon)
      ? await iconCandidates(dirs, icon)
      : [];
  for (const path of candidates) {
    const bytes = await read(path);
    if (bytes && bytes.length > 0 && bytes.length <= MAX_BYTES) return bytes;
  }
  return null;
}
