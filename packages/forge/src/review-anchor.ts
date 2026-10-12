import type { ForgeReviewAnchor } from "@ace/protocol/forge-review";
/** Hosted hunk coordinates; header and no-newline markers have no comment anchor. */
export function hostedDiffLines(patch: string): { text: string; left?: number; right?: number }[] {
  let left = 0,
    right = 0,
    active = false;
  return patch.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      active = true;
      return { text };
    }
    if (!active || text.startsWith("\\")) return { text };
    if (text.startsWith("-")) return { text, left: left++ };
    if (text.startsWith("+")) return { text, right: right++ };
    if (text.startsWith(" ")) return { text, left: left++, right: right++ };
    return { text };
  });
}
export function validHostedAnchor(patch: string, anchor: ForgeReviewAnchor): boolean {
  if (anchor.startSide && anchor.startSide !== anchor.side) return false;
  const start = anchor.startLine ?? anchor.line;
  if (start > anchor.line || anchor.line - start > 1000) return false;
  const lines = new Set(
    hostedDiffLines(patch).flatMap((line) => {
      const value = anchor.side === "LEFT" ? line.left : line.right;
      return value === undefined ? [] : [value];
    }),
  );
  for (let line = start; line <= anchor.line; line++) if (!lines.has(line)) return false;
  return true;
}
