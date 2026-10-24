/** A machine name as a branch-name fragment: `Arpan's MacBook Pro` → `arpans-macbook-pro`. */
export function machineSlug(machine: string): string {
  const slug = machine
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "machine";
}

/** The names a transferred branch may land under, in the order they are tried. */
export function landingCandidate(branch: string, machine: string, attempt: number): string {
  const suffixed = `${branch}-from-${machineSlug(machine)}`;
  return attempt === 0 ? branch : attempt === 1 ? suffixed : `${suffixed}-${attempt}`;
}

export interface LandingBranch {
  branch: string;
  /** The returned branch is already there, at `commit`. */
  existing: boolean;
}

/**
 * Where a transferred branch lands among the target's local branches (`heads`: name → commit).
 * A candidate is used only when free or already exactly at `commit`. A branch there at any
 * other commit, an ancestor included, is the target's own and is never moved: the transfer
 * lands beside it as `<branch>-from-<machine>`, then `-2`, `-3`…, each checked the same way.
 */
export function landingBranchName(input: {
  branch: string;
  commit: string;
  machine: string;
  heads: ReadonlyMap<string, string>;
}): LandingBranch {
  for (let attempt = 0; ; attempt++) {
    const name = landingCandidate(input.branch, input.machine, attempt);
    const current = input.heads.get(name);
    if (current === input.commit) return { branch: name, existing: true };
    if (current === undefined && !nests(name, input.heads))
      return { branch: name, existing: false };
  }
}

/** `a` cannot be created beside `a/b`, nor `a/b` beside `a`: refs are files in folders. */
function nests(name: string, heads: ReadonlyMap<string, string>): boolean {
  for (const head of heads.keys())
    if (head.startsWith(`${name}/`) || name.startsWith(`${head}/`)) return true;
  return false;
}
