/*
 * The draft pull request that reverts a merged one, as first offered: its title and a
 * description that says what it undoes. Pure.
 */

export const revertTitleLimit = 256;
export const revertBodyLimit = 60_000;

export function revertDraft(pr: { number: number; title: string }): {
  title: string;
  body: string;
} {
  return {
    title: `Revert "${pr.title}"`.slice(0, revertTitleLimit),
    body: `Reverts #${pr.number}.\n\nThis draft proposes undoing the merged change. Review the generated diff and required checks before merging.`,
  };
}
