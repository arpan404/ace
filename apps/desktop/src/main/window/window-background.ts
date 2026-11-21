import { readFileSync } from "node:fs";
import { durableJson } from "@ace/service";
import { WindowBackground } from "../../shared/contract.ts";
import { solidBackground } from "./options.ts";

/**
 * The colour behind the page: the page's own theme colour in the scheme its mode resolves to
 * (following the OS for "system"), or the default theme's until the page has said.
 */
export function windowBackground(saved: WindowBackground | undefined, osDark: boolean): string {
  if (!saved) return solidBackground(osDark);
  const dark = saved.mode === "system" ? osDark : saved.mode === "dark";
  return dark ? saved.dark : saved.light;
}

/** The page's last theme colours, kept in userData so the next launch's window starts in them. */
export class WindowBackgroundStore {
  private value: WindowBackground | undefined;
  private path: string;
  private writing = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.value = read(path);
  }
  get(): WindowBackground | undefined {
    return this.value;
  }
  /** True when the colours changed; `saved` settles once they are on disk (or failed to be). */
  set(next: WindowBackground): { changed: boolean; saved: Promise<void> } {
    const now = this.value;
    if (
      now &&
      now.mode === next.mode &&
      now.light === next.light &&
      now.dark === next.dark &&
      JSON.stringify(now.tray) === JSON.stringify(next.tray) &&
      JSON.stringify(now.trayUsage) === JSON.stringify(next.trayUsage)
    )
      return { changed: false, saved: Promise.resolve() };
    this.value = next;
    this.writing = this.writing.then(() => durableJson(this.path, next)).catch(() => {});
    return { changed: true, saved: this.writing };
  }
}

function read(path: string): WindowBackground | undefined {
  try {
    const parsed = WindowBackground.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
