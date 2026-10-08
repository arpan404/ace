import { checkoutFiles } from "./checkout-contents.ts";

/** Subsequence match on the path, preferring hits in the file name, best first. */
export function completePaths(
  workspaceId: string,
  query: string,
  limit: number,
  paths: readonly string[] = Object.keys(checkoutFiles(workspaceId)),
): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    if (path.endsWith("/")) continue;
    const lower = path.toLowerCase();
    let at = 0;
    for (const char of q) {
      at = lower.indexOf(char, at);
      if (at < 0) break;
      at++;
    }
    if (at < 0) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    scored.push({ path, score: (name.includes(q) ? 0 : 1) * 1000 + path.length });
  }
  return scored
    .toSorted((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.path);
}
