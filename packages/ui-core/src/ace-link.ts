/**
 * `ace://` links, read the same way by the desktop app and the phone:
 * `ace://thread/<id>[/item/<itemId>][?machine=<hostId>]`, `ace://settings[/<page>]`,
 * `ace://new[?project=<id>][&machine=<hostId>]` and `ace://open?folder=<absolute folder>`
 * (`path=` is the older spelling). Anything else is not a link.
 *
 * Links come from other apps and the OS, so they are untrusted: the text is bounded, every
 * part is decoded once and checked, and a malformed escape makes the whole link unreadable.
 * Written without `URL`, which the phone's JavaScriptCore doesn't have. Pure.
 */
export type AceLink =
  | { kind: "thread"; threadId: string; itemId?: string; machine?: string }
  | { kind: "settings"; page?: string }
  | { kind: "new-thread"; project?: string; machine?: string }
  | { kind: "open-folder"; path: string };

const scheme = "ace://";
const longest = 4096;
/**
 * Protocol ids are opaque: any non-empty text, encoded slashes and spaces included, within the
 * link's overall bound. Only an empty one is not an id.
 */
function id(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function readAceLink(input: string): AceLink | undefined {
  const text = input.trim();
  if (text.length > longest || text.slice(0, scheme.length).toLowerCase() !== scheme)
    return undefined;
  const rest = text.slice(scheme.length).split("#")[0] ?? "";
  const mark = rest.indexOf("?");
  const pathPart = mark < 0 ? rest : rest.slice(0, mark);
  const queryPart = mark < 0 ? "" : rest.slice(mark + 1);
  const segments: string[] = [];
  for (const raw of pathPart.split("/")) {
    if (!raw) continue;
    const segment = decode(raw);
    if (segment === undefined) return undefined;
    segments.push(segment);
  }
  const query = new Map<string, string>();
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const key = decode(equals < 0 ? pair : pair.slice(0, equals));
    const value = decode(equals < 0 ? "" : pair.slice(equals + 1).replaceAll("+", " "));
    if (key === undefined || value === undefined) return undefined;
    if (!query.has(key)) query.set(key, value);
  }
  const machine = query.has("machine") ? id(query.get("machine")) : undefined;
  if (query.has("machine") && machine === undefined) return undefined;
  const [kind, first, second, third] = segments;
  switch (kind?.toLowerCase()) {
    case "thread": {
      // `thread/<id>` or `thread/<id>/item/<item>`; any other shape names nothing.
      const threadId = id(first);
      if (!threadId) return undefined;
      if (second === undefined && segments.length === 2)
        return { kind: "thread", threadId, ...(machine ? { machine } : {}) };
      const itemId = second === "item" && segments.length === 4 ? id(third) : undefined;
      if (!itemId) return undefined;
      return { kind: "thread", threadId, itemId, ...(machine ? { machine } : {}) };
    }
    case "settings":
      if (first === undefined) return { kind: "settings" };
      return /^[a-z-]{1,40}$/.test(first) ? { kind: "settings", page: first } : undefined;
    case "new": {
      const project = query.has("project") ? id(query.get("project")) : undefined;
      if (query.has("project") && project === undefined) return undefined;
      return {
        kind: "new-thread",
        ...(project ? { project } : {}),
        ...(machine ? { machine } : {}),
      };
    }
    case "open": {
      const path = query.get("folder") ?? query.get("path");
      return path && isAbsolute(path) && !path.includes("\0")
        ? { kind: "open-folder", path }
        : undefined;
    }
    default:
      return undefined;
  }
}
