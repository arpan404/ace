import { contentHash, patchSections } from "@ace/ui-core";

/*
 * The fake's `git.diff` reply from a seeded patch, bounded like the daemon's: the whole checkout
 * stops at 256 KiB, and one file (`path`) reads in pages from `offset`, each ending on a line
 * break with the `nextOffset` of the next, all named by the section's hash as `validator`. A page
 * asked for at another `expected` version is refused with `diff_changed`, as the daemon does.
 */

const cap = 262_144;

export function fakeGitDiff(
  patch: string,
  op: { path?: string | undefined; offset?: number | undefined; expected?: string | undefined },
):
  | { kind: "gitDiff"; patch: string; truncated: boolean; nextOffset?: number; validator?: string }
  | { kind: "error"; code: string } {
  if (op.path === undefined)
    return patch.length > cap
      ? { kind: "gitDiff", patch: patch.slice(0, cap), truncated: true }
      : { kind: "gitDiff", patch, truncated: false };
  const text = patchSections(patch).find((section) => section.path === op.path)?.text ?? "";
  const validator = contentHash(text);
  if (op.expected !== undefined && op.expected !== validator)
    return { kind: "error", code: "diff_changed" };
  const start = Math.min(op.offset ?? 0, text.length);
  if (text.length - start <= cap)
    return { kind: "gitDiff", patch: text.slice(start), truncated: false, validator };
  const breakAt = text.lastIndexOf("\n", start + cap - 1);
  const end = breakAt >= start ? breakAt + 1 : start + cap;
  return {
    kind: "gitDiff",
    patch: text.slice(start, end),
    truncated: true,
    nextOffset: end,
    validator,
  };
}
