import { patchSections } from "@ace/ui-core";

/*
 * The fake's `git.diff` reply from a seeded patch, bounded like the daemon's: the whole checkout
 * stops at 256 KiB, and one file (`path`) reads in pages from `offset`, each ending on a line
 * break with the `nextOffset` of the next.
 */

const cap = 262_144;

export function fakeGitDiff(
  patch: string,
  op: { path?: string | undefined; offset?: number | undefined },
): { patch: string; truncated: boolean; nextOffset?: number } {
  if (op.path === undefined)
    return patch.length > cap
      ? { patch: patch.slice(0, cap), truncated: true }
      : { patch, truncated: false };
  const text = patchSections(patch).find((section) => section.path === op.path)?.text ?? "";
  const start = Math.min(op.offset ?? 0, text.length);
  if (text.length - start <= cap) return { patch: text.slice(start), truncated: false };
  const breakAt = text.lastIndexOf("\n", start + cap - 1);
  const end = breakAt >= start ? breakAt + 1 : start + cap;
  return { patch: text.slice(start, end), truncated: true, nextOffset: end };
}
