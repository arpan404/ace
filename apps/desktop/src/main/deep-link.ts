import { DeepLink } from "../shared/contract.ts";

export const protocolScheme = "ace";

const windows = process.platform === "win32";

/**
 * Windows: a path naming another computer or a device: two leading slashes or backslashes, as in
 * a UNC share, a `\\?\UNC` long path or a `\\.` device path. Merely looking at one makes
 * Windows connect over SMB and offer the person's credentials, so a link or argument from
 * outside never names one.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** Windows: a link that would open a folder on another computer (`isNetworkPath`). */
export function opensNetworkFolder(link: DeepLink): boolean {
  return link.kind === "open-folder" && isNetworkPath(link.path);
}

/**
 * Parses `ace://` links:
 * `ace://thread/<id>[/item/<itemId>]`, `ace://settings[/<page>]`,
 * `ace://new` and `ace://open?folder=<absolute folder>` (`path=` is the older spelling).
 * Anything else is ignored.
 */
export function parseDeepLink(input: string): DeepLink | undefined {
  let url: URL;
  let segments: string[];
  try {
    url = new URL(input);
    // OS arguments are untrusted, including malformed UTF-8 and percent escapes.
    segments = [url.hostname, ...url.pathname.split("/")]
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (url.protocol !== `${protocolScheme}:`) return undefined;
  // `ace://thread/abc`: the first segment parses as the host.
  const [kind, first, second, third] = segments;
  const candidate = (() => {
    switch (kind) {
      case "thread":
        return second === "item" && third
          ? { kind, threadId: first, itemId: third }
          : { kind, threadId: first };
      case "settings":
        return first ? { kind, page: first } : { kind };
      case "new":
        return { kind: "new-thread" };
      case "open":
        return {
          kind: "open-folder",
          path: url.searchParams.get("folder") ?? url.searchParams.get("path"),
        };
      default:
        return undefined;
    }
  })();
  if (kind === "settings" && first && !/^[a-z-]{1,40}$/.test(first)) return undefined;
  const parsed = DeepLink.safeParse(candidate);
  if (parsed.success && windows && opensNetworkFolder(parsed.data)) return undefined;
  return parsed.success ? parsed.data : undefined;
}

/**
 * Links and folders from launch or second-instance arguments (without the executable and,
 * in development, the app path): `ace://…` arguments, and
 * absolute folder paths from "Open in ace" (Explorer, the Linux file manager, the dock).
 */
export function linksFromArgv(
  argv: readonly string[],
  isDirectory: (path: string) => boolean,
): DeepLink[] {
  const links: DeepLink[] = [];
  for (const argument of argv) {
    if (argument.startsWith(`${protocolScheme}://`)) {
      const link = parseDeepLink(argument);
      if (link) links.push(link);
    } else {
      const path = localPath(argument);
      // Windows: checked before `isDirectory`, whose stat would already reach the server.
      if (path && windows && isNetworkPath(path)) continue;
      if (path && isDirectory(path)) links.push({ kind: "open-folder", path });
    }
  }
  return links;
}

/**
 * An argument naming a local file: an absolute path, or a `file://` URI on this machine (a
 * Linux launcher may pass one for the desktop entry's `%U`). Flags and anything else are not.
 */
function localPath(argument: string): string | undefined {
  if (argument.startsWith("-")) return undefined;
  if (isAbsolute(argument)) return argument;
  if (!argument.startsWith("file:")) return undefined;
  try {
    const url = new URL(argument);
    if (url.host && url.host !== "localhost") return undefined;
    const path = decodeURIComponent(url.pathname);
    return isAbsolute(path) && !path.includes("\0") ? path : undefined;
  } catch {
    return undefined;
  }
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
