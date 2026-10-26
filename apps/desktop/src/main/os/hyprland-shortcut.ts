import type { RunProgram } from "./tray-host.ts";

/** The app id the GlobalShortcuts portal knows ace by (`desktopName`, scripts/build.ts). */
const appId = "dev.ace.app";

/**
 * Hyprland's portal accepts an app's global shortcuts but never gives them keys: the person
 * binds one in hyprland.conf as `bind = MODS, KEY, global, <app id>:<shortcut id>`. Electron
 * names its portal shortcuts with an id of its own (a hash of a per-profile id and the
 * accelerator), so the exact line is read back from Hyprland's list once the shortcut is
 * registered. Reading that list is all ace asks of Hyprland; it never binds keys itself.
 */
export function hyprlandBind(listing: unknown, accelerator: string): string | undefined {
  if (!Array.isArray(listing)) return undefined;
  const keys = hyprlandKeys(accelerator);
  const wanted = chord(accelerator);
  if (!keys || !wanted) return undefined;
  for (const entry of listing) {
    if (typeof entry !== "object" || entry === null) continue;
    const name: unknown = Reflect.get(entry, "name");
    const description: unknown = Reflect.get(entry, "description");
    if (typeof name !== "string" || !name.startsWith(`${appId}:`) || /[\s,]/.test(name)) continue;
    // Chromium describes each shortcut as "<app> shortcut: Ctrl+Shift+Space", in its own
    // spelling of the keys (Ctrl for CommandOrControl).
    const registered = typeof description === "string" ? description.split(": ").at(-1) : "";
    if (registered && chord(registered) === wanted) return `bind = ${keys}, global, ${name}`;
  }
  return undefined;
}

/** Hyprland's word for each modifier, from Electron's and Chromium's spellings. */
const modifiers: Record<string, string> = {
  commandorcontrol: "CTRL",
  cmdorctrl: "CTRL",
  control: "CTRL",
  ctrl: "CTRL",
  shift: "SHIFT",
  alt: "ALT",
  option: "ALT",
  altgr: "ALT",
  super: "SUPER",
  meta: "SUPER",
  command: "SUPER",
  cmd: "SUPER",
  search: "SUPER",
};

/** A chord spelled either way, as one comparable string: sorted modifiers, then the key. */
function chord(accelerator: string): string | undefined {
  const parts = accelerator.split("+").filter(Boolean);
  const key = parts.pop();
  const mods = parts.map((part) => modifiers[part.toLowerCase()]);
  if (!key || mods.length === 0 || mods.some((mod) => mod === undefined)) return undefined;
  return `${[...new Set(mods)].toSorted().join(" ")}+${key.toLowerCase()}`;
}

/** `CommandOrControl+Shift+Space` as hyprland.conf writes it: `CTRL SHIFT, Space`. */
export function hyprlandKeys(accelerator: string): string | undefined {
  const parts = accelerator.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key || parts.length === 0) return undefined;
  const mods = parts.map((part) => modifiers[part.toLowerCase()]);
  if (mods.some((mod) => mod === undefined)) return undefined;
  return `${[...new Set(mods)].join(" ")}, ${key.length === 1 ? key.toUpperCase() : key}`;
}

/** Whether this session is Hyprland, which sets its instance signature for its own clients. */
export function onHyprland(env: Readonly<Record<string, string | undefined>>): boolean {
  return !!env.HYPRLAND_INSTANCE_SIGNATURE && !!env.WAYLAND_DISPLAY;
}

/**
 * The sentence Settings shows under the quick-thread shortcut on Hyprland, with the line to
 * add; undefined elsewhere, or when Hyprland doesn't list the shortcut yet.
 */
export async function hyprlandShortcutHint(options: {
  env: Readonly<Record<string, string | undefined>>;
  accelerator: string | null;
  run: RunProgram;
}): Promise<string | undefined> {
  if (!options.accelerator || !onHyprland(options.env)) return undefined;
  let listing: unknown;
  try {
    listing = JSON.parse(await options.run("hyprctl", ["globalshortcuts", "-j"]));
  } catch {
    return undefined;
  }
  const bind = hyprlandBind(listing, options.accelerator);
  return bind
    ? `Hyprland gives apps' shortcuts no keys. Add this line to hyprland.conf: ${bind}`
    : undefined;
}
