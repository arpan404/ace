/**
 * Opening for Markdown web links (Android transcript).
 *
 * Only `http(s)` URLs validated by `isSafeWebUrl` ever open, via the
 * system browser. `ace://` references stay inert in Markdown: Android has no
 * in-message file opener, so the thread Files screen remains the only file
 * route. Never throws; failures report `false` for tests and stay silent in
 * the transcript.
 */

import { isSafeWebUrl } from "./markdown.ts";

export interface WebLinkOpener {
  openURL(url: string): unknown;
}

export async function openWebLink(url: string, opener?: WebLinkOpener): Promise<boolean> {
  if (!isSafeWebUrl(url)) return false;
  try {
    const target = opener ?? loadLinking();
    const result = target.openURL(url);
    if (result !== undefined && result !== null) await result;
    return true;
  } catch {
    return false;
  }
}

function loadLinking(): WebLinkOpener {
  // Lazy so unit tests and bundles without react-native stay alive.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const linking = require("react-native") as {
    Linking: WebLinkOpener;
  };
  return linking.Linking;
}
