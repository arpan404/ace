/*
 * What a standing grant does, named once as a pressable action: the shared verb ("Always
 * allow") followed by what the provider's own words say it covers. Providers often repeat the
 * verb in their words ("Always here", "Yes, and don't ask again for npm install"), so the
 * lead-in they share with the verb is dropped: "Always allow here", "Always allow for npm
 * install". Words that add nothing leave the verb alone. Pure.
 */

/** Lead-ins that only restate the verb, longest first. */
const restated = [
  /^yes,?\s+and\s+don['’]t\s+ask\s+again\b/i,
  /^don['’]t\s+ask\s+again\b/i,
  /^yes,?\s+and\b/i,
  /^always\s+allow\b/i,
  /^always\b/i,
  /^allow\b/i,
];

export function grantName(verb: string, scope: string): string {
  let rest = scope.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const lead of restated) {
      const next = rest.replace(lead, "").replace(/^[\s,.:;—–-]+/, "");
      if (next !== rest) {
        rest = next;
        changed = true;
      }
    }
  }
  rest = rest.replace(/[\s.]+$/, "");
  return rest ? `${verb} ${rest}` : verb;
}
