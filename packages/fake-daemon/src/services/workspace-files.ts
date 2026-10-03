/** Checkout contents of the fake daemon's projects, for `@` mention completion. */
const files: Record<string, readonly string[]> = {
  relay: [
    "apps/server/src/replay.ts",
    "apps/server/src/cursor.ts",
    "apps/server/src/resume.ts",
    "apps/server/src/replay.spec.ts",
    "apps/web/src/relay/outbox.ts",
    "apps/web/src/relay/socket.ts",
    "apps/mobile/src/resume.ts",
    "packages/protocol/src/events.ts",
    "README.md",
    "package.json",
  ],
};
const fallback = [
  "src/index.ts",
  "src/app.tsx",
  "src/routes/index.tsx",
  "src/lib/fetch.ts",
  "src/checkout/payment-poller.ts",
  "src/checkout/checkout.spec.ts",
  "package.json",
  "README.md",
];

/** Subsequence match on the path, preferring hits in the file name, best first. */
export function completePaths(workspaceId: string, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of files[workspaceId] ?? fallback) {
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
