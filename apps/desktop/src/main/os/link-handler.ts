import { isAbsolute, join } from "node:path";
import type { AutostartFiles } from "./autostart.ts";
import { desktopFileId } from "./appimage-entry.ts";

const scheme = "x-scheme-handler/ace";
const section = "[Default Applications]";
/** What earlier AppImage launches named the app; a default pointing at it is ours to move. */
const ours = new Set([desktopFileId, "ace-desktop.desktop"]);

/**
 * The person's `mimeapps.list` with ace as the default for `ace://` links, or undefined when it
 * already is, or when the person picked another app. Pure.
 */
export function withAceLinkDefault(text: string | undefined): string | undefined {
  const lines = (text ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const wanted = `${scheme}=${desktopFileId};`;
  let start = lines.findIndex((line) => line.trim() === section);
  if (start === -1) {
    if (lines.length > 0) lines.push("");
    lines.push(section, wanted);
    return `${lines.join("\n")}\n`;
  }
  let end = lines.findIndex((line, index) => index > start && line.trim().startsWith("["));
  if (end === -1) end = lines.length;
  for (let index = start + 1; index < end; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith(`${scheme}=`)) continue;
    const first =
      line
        .slice(scheme.length + 1)
        .split(";")[0]
        ?.trim() ?? "";
    if (first === desktopFileId) return undefined;
    if (first !== "" && !ours.has(first)) return undefined;
    lines[index] = wanted;
    return `${lines.join("\n")}\n`;
  }
  start += 1;
  lines.splice(start, 0, wanted);
  return `${lines.join("\n")}\n`;
}

/**
 * Makes ace the person's default app for `ace://` links, so a browser coming back from ace
 * sign-in finds the app. A menu entry alone only says ace can open them; GNOME's portal and
 * GIO open the default from `mimeapps.list`, which `xdg-settings` (Electron's own route) never
 * writes where xdg-utils is missing. A default the person set to another app is kept.
 */
export function claimAceLinks(options: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  files: AutostartFiles;
  warn(message: string): void;
}): void {
  const configured = options.env.XDG_CONFIG_HOME;
  const config = configured && isAbsolute(configured) ? configured : join(options.home, ".config");
  const path = join(config, "mimeapps.list");
  try {
    const next = withAceLinkDefault(options.files.read(path));
    if (next !== undefined) options.files.write(path, next);
  } catch (error) {
    options.warn(`Could not make ace open ace:// links (${path}): ${String(error)}`);
  }
}
