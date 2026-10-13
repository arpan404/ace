import type { ForgeLocalStack, ForgeStack, ForgeStackExpected } from "@ace/protocol/forge-stacks";
export const stackRebasedLocally =
  "Local branches are rebased and not yet pushed. Publish the stack to update GitHub; each layer moves only if GitHub still has the revision reviewed before the rebase.";
export function canPublishStack(stack: ForgeStack): boolean {
  return stack.layers.every((layer) => ["OPEN", "DRAFT", "MERGED"].includes(layer.state));
}
/** Local JSON comes from the documented `gh stack view --json` contract. */
export function matchesStackBranches(local: ForgeLocalStack, stack: ForgeStack): boolean {
  const branches = local.branches.filter((branch) => !branch.isMerged);
  const layers = stack.layers.filter((layer) => layer.state !== "MERGED");
  return (
    local.trunk === stack.trunk &&
    branches.length > 0 &&
    branches.length === layers.length &&
    branches.every((branch, index) => {
      const layer = layers[index];
      if (!layer || !branch.pr || branch.name !== layer.branch || branch.pr.number !== layer.number)
        return false;
      return branch.pr.url.toLowerCase() === layer.url.toLowerCase();
    })
  );
}
export function sameLocalStack(a: ForgeLocalStack, b: ForgeLocalStack): boolean {
  return (
    a.trunk === b.trunk &&
    a.currentBranch === b.currentBranch &&
    a.branches.length === b.branches.length &&
    a.branches.every((branch, index) => {
      const other = b.branches[index];
      return (
        other &&
        branch.name === other.name &&
        branch.head === other.head &&
        branch.base === other.base &&
        branch.pr?.number === other.pr?.number &&
        branch.isMerged === other.isMerged &&
        branch.isQueued === other.isQueued
      );
    })
  );
}

export function sameStack(expected: ForgeStackExpected, current: ForgeStack): boolean {
  return (
    expected.id === current.id &&
    expected.trunk === current.trunk &&
    expected.layers.length === current.layers.length &&
    expected.layers.every(
      (entry, index) =>
        entry.number === current.layers[index]?.number &&
        entry.headSha === current.layers[index]?.headSha,
    )
  );
}

export function matchesLocalStack(local: ForgeLocalStack, stack: ForgeStack): boolean {
  const active = local.branches.filter((branch) => !branch.isMerged);
  return (
    matchesStackBranches(local, stack) &&
    active.filter((branch) => branch.isCurrent).length === 1 &&
    active.some((branch) => branch.isCurrent && branch.name === local.currentBranch)
  );
}

export function stackPrState(pr: { state: string; isDraft: boolean }): string {
  return pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state;
}
