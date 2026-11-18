/**
 * Chromium switches that let another process drive this app's pages (ADR 0178 §12.8). Started
 * with one, the app is no longer only the person's: whoever passed it could drive the page, so
 * the app gives its daemon no key and its page acts with the host token alone, as any client.
 * The Node and inspector switches are already off by the app's fuses.
 */
const drivenFromOutside = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/** Whether this launch may give its daemon a key: none of those switches is set. */
export function appStandingAllowed(hasSwitch: (name: string) => boolean): boolean {
  return drivenFromOutside.every((name) => !hasSwitch(name));
}
