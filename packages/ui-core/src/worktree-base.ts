import type { BranchRef, WorktreeBase, WorktreeBaseRecord } from "@ace/protocol";

/** How a base reads: `origin/main` for a remote's branch, `main` for a local one. */
export function baseName(base: WorktreeBase): string {
  return base.remote ? `${base.remote}/${base.ref}` : base.ref;
}

export const sameBase = (a: WorktreeBase | undefined, b: WorktreeBase | undefined): boolean =>
  a?.ref === b?.ref && a?.remote === b?.remote;

const usualDefaults = ["main", "master", "trunk", "develop"];

/**
 * The base a new worktree starts from when the person hasn't picked one: the repository's
 * default branch at its freshest. That is the remote's copy (fetched just before the worktree is
 * made) unless the local branch has commits the remote doesn't, in which case the person's own
 * work wins; without a remote copy it is the local branch. With no default branch known, the
 * usual names (main, master…) stand in, then the first branch listed.
 */
export function defaultWorktreeBase(
  refs: readonly BranchRef[],
  defaultBranch: string | undefined,
): WorktreeBase | undefined {
  const named =
    defaultBranch ?? usualDefaults.find((name) => refs.some((ref) => ref.name === name));
  if (named !== undefined) {
    const local = refs.find((ref) => !ref.remote && ref.name === named);
    const upstream = local?.upstream ? splitUpstream(local.upstream, refs) : undefined;
    const remote =
      (upstream &&
        refs.find((ref) => ref.remote === upstream.remote && ref.name === upstream.ref)) ??
      refs.find((ref) => ref.remote === "origin" && ref.name === named) ??
      refs.find((ref) => ref.remote && ref.name === named);
    if (remote?.remote && !(local && (local.ahead ?? 0) > 0))
      return { ref: remote.name, remote: remote.remote };
    if (local) return { ref: local.name };
  }
  const first = refs[0];
  return first && (first.remote ? { ref: first.name, remote: first.remote } : { ref: first.name });
}

/** `origin/feature/x` as the remote and branch it names, by the remotes the refs list. */
function splitUpstream(upstream: string, refs: readonly BranchRef[]): WorktreeBase | undefined {
  for (const ref of refs)
    if (ref.remote && upstream === `${ref.remote}/${ref.name}`)
      return { ref: ref.name, remote: ref.remote };
  return undefined;
}

/** A base's place in the picker: what it is called and what to say beside it. */
export interface BaseOption {
  base: WorktreeBase;
  label: string;
  /** "default", "3 behind origin", "2 ahead of origin"… */
  note: string | undefined;
}

/**
 * The bases a picker offers, grouped: the remotes' branches first (they are what a new piece of
 * work usually starts from), then local ones, each group with the default branch on top and the
 * rest by name. `query` narrows them by a case-insensitive match anywhere in the full name.
 */
export function baseOptions(
  refs: readonly BranchRef[],
  defaultBranch: string | undefined,
  query = "",
): { remote: BaseOption[]; local: BaseOption[] } {
  const needle = query.trim().toLowerCase();
  const options = refs
    .map((ref): BaseOption => {
      const base = ref.remote ? { ref: ref.name, remote: ref.remote } : { ref: ref.name };
      return { base, label: baseName(base), note: noteFor(ref, defaultBranch) };
    })
    .filter((option) => !needle || option.label.toLowerCase().includes(needle));
  const order = (a: BaseOption, b: BaseOption) =>
    Number(b.base.ref === defaultBranch) - Number(a.base.ref === defaultBranch) ||
    a.label.localeCompare(b.label);
  return {
    remote: options.filter((option) => option.base.remote).toSorted(order),
    local: options.filter((option) => !option.base.remote).toSorted(order),
  };
}

function noteFor(ref: BranchRef, defaultBranch: string | undefined): string | undefined {
  const parts: string[] = [];
  if (ref.name === defaultBranch) parts.push("default");
  const remote = ref.upstream?.split("/")[0];
  if (!ref.remote && remote && (ref.behind ?? 0) > 0) parts.push(`${ref.behind} behind ${remote}`);
  if (!ref.remote && remote && (ref.ahead ?? 0) > 0) parts.push(`${ref.ahead} ahead of ${remote}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * What a thread's worktree started from, in words: "origin/main at 1a2b3c4", with why it may be
 * older than the remote when the remote couldn't be reached.
 */
export function baseRecordText(record: WorktreeBaseRecord): { text: string; note?: string } {
  const text = `${baseName(record)} at ${record.head.slice(0, 7)}`;
  return record.fetch === "unreachable"
    ? {
        text,
        note: `${record.remote ?? "The remote"} couldn't be reached, so it started from the last fetched copy.`,
      }
    : { text };
}
