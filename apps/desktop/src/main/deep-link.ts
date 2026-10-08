import { DeepLink } from "../shared/contract.ts";

export const protocolScheme = "ace";

/**
 * Parses `ace://` links:
 * `ace://thread/<id>[/item/<itemId>]`, `ace://settings[/<page>]`,
 * `ace://new` and `ace://open?folder=<absolute folder>` (`path=` is the older spelling).
 * Anything else is ignored.
 */
export function parseDeepLink(input: string): DeepLink | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${protocolScheme}:`) return undefined;
  // `ace://thread/abc`: the first segment parses as the host.
  const segments = [url.hostname, ...url.pathname.split("/")]
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
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
    } else if (!argument.startsWith("-") && isAbsolute(argument) && isDirectory(argument)) {
      links.push({ kind: "open-folder", path: argument });
    }
  }
  return links;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
