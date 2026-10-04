import { fileChanges, type Turn } from "@ace/ui-core";
import type { BrowserView, PreviewServer } from "../sources.ts";

/*
 * What the new-tab launcher suggests opening for a thread: the local addresses it has running
 * or showing, and the files its agents edited most recently. Pure, from live state.
 */

export interface UrlSuggestion {
  url: string;
  /** "localhost:5173", or the dev server's name when it has one. */
  label: string;
  /** Where it came from: "Dev server", "Open in the browser". */
  detail: string;
}

export interface FileSuggestion {
  path: string;
  /** The file name, shown first. */
  name: string;
  /** The folder it is in, muted after the name. */
  folder: string;
}

const hostOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return url;
  }
};

function withScheme(url: string): string | undefined {
  if (!url || url.startsWith("about:")) return undefined;
  return /^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

/** The browser's page first, then each dev server once, at most `limit`. */
export function urlSuggestions(
  view: BrowserView | undefined,
  servers: readonly PreviewServer[],
  limit = 4,
): UrlSuggestion[] {
  const out: UrlSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: UrlSuggestion) => {
    const key = suggestion.url.replace(/\/$/, "");
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(suggestion);
  };
  // The relay reports pages as typed ("localhost:5173/settings"); give them a scheme.
  const page = view && !view.closed ? withScheme(view.url) : undefined;
  if (page) add({ url: page, label: hostOf(page), detail: "Open in the thread's browser" });
  for (const server of servers) {
    const url = server.origin ?? `http://localhost:${server.port}`;
    add({ url, label: server.name ?? hostOf(url), detail: `Dev server · port ${server.port}` });
  }
  return out;
}

/** The files edited in the latest turns, newest first, each once, at most `limit`. */
export function fileSuggestions(turns: readonly Turn[], limit = 6): FileSuggestion[] {
  const out: FileSuggestion[] = [];
  const seen = new Set<string>();
  for (let t = turns.length - 1; t >= 0 && out.length < limit; t--) {
    const edits = turns[t]?.edits ?? [];
    for (let e = edits.length - 1; e >= 0 && out.length < limit; e--) {
      const changes = fileChanges(edits[e]);
      for (let c = changes.length - 1; c >= 0 && out.length < limit; c--) {
        const change = changes[c];
        if (!change) continue;
        const path = change.movePath ?? change.path;
        if (seen.has(path)) continue;
        seen.add(path);
        const slash = path.lastIndexOf("/");
        out.push({
          path,
          name: path.slice(slash + 1),
          folder: slash > 0 ? path.slice(0, slash) : "",
        });
      }
    }
  }
  return out;
}
