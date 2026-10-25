import { GitError } from "./types.ts";

/** A machine name as a branch-name fragment: `Arpan's MacBook Pro` → `arpans-macbook-pro`. */
export function machineSlug(machine: string): string {
  const slug = machine
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "machine";
}

/** Suffixed names tried per spelling of the branch before landing gives up. */
const maxSuffixes = 100;

/**
 * The names a transferred branch may land under, in the order they are tried: the branch
 * itself, then `<branch>-from-<machine>`, `-2`, `-3`… When the branch has folders (`a/b`), the
 * same suffixes follow with the folders flattened (`a-b-from-<machine>`), so a target branch
 * named like one of those folders (`a`) can't block every candidate.
 */
export function* landingCandidates(branch: string, machine: string): Generator<string> {
  yield branch;
  const slug = machineSlug(machine);
  const spellings = [branch, ...(branch.includes("/") ? [branch.replaceAll("/", "-")] : [])];
  for (const spelling of spellings)
    for (let n = 1; n <= maxSuffixes; n++)
      yield n === 1 ? `${spelling}-from-${slug}` : `${spelling}-from-${slug}-${n}`;
}

export interface LandingBranch {
  branch: string;
  /** The returned branch is already there, at `commit`. */
  existing: boolean;
}

/**
 * Where a transferred branch lands among the target's local branches (`heads`: name → commit).
 * A candidate is used only when free, or already exactly at `commit` and not checked out in any
 * worktree (`occupied`), since the landing may need its own worktree on it. A branch there at any
 * other commit, an ancestor included, is the target's own and is never moved: the transfer
 * lands beside it (see `landingCandidates`). `ref_conflict` when every candidate is taken.
 */
export function landingBranchName(input: {
  branch: string;
  commit: string;
  machine: string;
  heads: ReadonlyMap<string, string>;
  occupied?: ReadonlySet<string> | undefined;
}): LandingBranch {
  for (const name of landingCandidates(input.branch, input.machine)) {
    const current = input.heads.get(name);
    if (current === input.commit && !input.occupied?.has(name))
      return { branch: name, existing: true };
    if (current === undefined && !nests(name, input.heads))
      return { branch: name, existing: false };
  }
  throw new GitError(
    "ref_conflict",
    `No free branch name for ${input.branch.slice(0, 200)}: the names it would land under are all taken`,
  );
}

/** `a` cannot be created beside `a/b`, nor `a/b` beside `a`: refs are files in folders. */
function nests(name: string, heads: ReadonlyMap<string, string>): boolean {
  for (const head of heads.keys())
    if (head.startsWith(`${name}/`) || name.startsWith(`${head}/`)) return true;
  return false;
}
