import { isStableVersion } from "@ace/service/release-line";
import { planBetaTag } from "./beta-plan.ts";
import { releaseTag } from "./release-plan.ts";

/**
 * Which release a pushed tag starts (ADR 0188), as a pure decision over facts the pipeline
 * reads first: whether the tag's commit is on `origin/main`, `apps/desktop/package.json`'s
 * version at that commit, and the tags GitHub has.
 *
 * - `ace-<X.Y.Z>-beta-<N>` is a beta, checked by the same rules as `release:beta build`
 *   (ADR 0177).
 * - `v<X.Y.Z>` is a stable release; `package.json` must already be at `X.Y.Z`, bumped in a PR.
 */

export interface ReleaseFacts {
  tag: string;
  /** The tag's commit is an ancestor of (or is) `origin/main`. */
  onMain: boolean;
  /** `apps/desktop/package.json`'s version at the tag's commit. */
  appVersion: string;
  /** Every tag GitHub has, this one included. */
  tags: readonly string[];
}

export interface TaggedRelease {
  kind: "beta" | "stable";
  tag: string;
  /** The version the app is built as: `X.Y.Z` or `X.Y.Z-beta.<N>`. */
  version: string;
  title: string;
}

export type TagVerdict = { ok: true; release: TaggedRelease } | { ok: false; problems: string[] };

const stableTag = /^v(.+)$/;

function stableRelease(facts: ReleaseFacts, version: string): TaggedRelease | string {
  if (!isStableVersion(version)) return `${facts.tag} is not a release tag: use vX.Y.Z`;
  if (facts.appVersion !== version)
    return `apps/desktop/package.json is at ${facts.appVersion} at ${facts.tag}; bump it to ${version} in a PR before tagging`;
  return { kind: "stable", tag: releaseTag(version), version, title: `ace ${version}` };
}

function betaRelease(facts: ReleaseFacts): TaggedRelease | string {
  try {
    const plan = planBetaTag({ stable: facts.appVersion, tag: facts.tag, tags: facts.tags });
    return { kind: "beta", tag: plan.tag, version: plan.version, title: plan.title };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The release `facts.tag` starts, or every reason it can't start one. */
export function releaseForTag(facts: ReleaseFacts): TagVerdict {
  const problems: string[] = [];
  if (!facts.onMain) problems.push(`${facts.tag} points at a commit that isn't on origin/main`);
  const stable = stableTag.exec(facts.tag);
  const release = stable ? stableRelease(facts, stable[1] ?? "") : betaRelease(facts);
  if (typeof release === "string") problems.push(release);
  if (problems.length || typeof release === "string") return { ok: false, problems };
  return { ok: true, release };
}
