import { contentSecurityPolicy, inlineScriptHashes } from "@ace/html/app-policy";

export { contentSecurityPolicy, inlineScriptHashes };

/** The custom scheme the packaged renderer is served from (`app://ace/…`). */
export const appScheme = "app";
export const appOrigin = `${appScheme}://ace`;

/**
 * The packaged renderer's policy. Chat visualizations are `<webview>` guests in their own locked
 * session (visualization-isolation.ts), so this policy never applies to their scripts.
 */
export function packagedPolicy(options: {
  index: string;
  daemonOrigins: readonly string[];
  dynamicDaemons: boolean;
}): string {
  return contentSecurityPolicy({
    inlineScripts: inlineScriptHashes(options.index),
    daemonOrigins: options.daemonOrigins,
    dynamicDaemons: options.dynamicDaemons,
  });
}

/**
 * Where the renderer may navigate itself: only its own origin. Compared by scheme and host,
 * because Node's `URL.origin` is "null" for every custom scheme such as `app:`.
 */
export function isAppUrl(url: string, rendererOrigin: string): boolean {
  try {
    const target = new URL(url);
    const own = new URL(rendererOrigin);
    return target.protocol === own.protocol && target.host === own.host && own.host !== "";
  } catch {
    return false;
  }
}

/** Links the user may open in the system browser. */
export function isExternalUrl(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
