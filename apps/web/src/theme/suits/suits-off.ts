import type { KeyValueStorage } from "@ace/ui-core";

/*
 * The escape hatch (ADR 0150): `?suit=off` in the URL turns Suits off on this device for the
 * rest of the session, even after the router drops the query; `?suit=on` turns them back on.
 * `index.html` reads the same key before first paint, so a broken Suit never draws.
 */
export const suitsOffKey = "ace.suits-off";

export function suitsOffForSession(search: string, session: KeyValueStorage | undefined): boolean {
  const asked = new URLSearchParams(search).get("suit");
  try {
    if (asked === "off") session?.setItem(suitsOffKey, "1");
    else if (asked === "on") session?.removeItem?.(suitsOffKey);
    return session?.getItem(suitsOffKey) === "1" || asked === "off";
  } catch {
    return asked === "off";
  }
}
