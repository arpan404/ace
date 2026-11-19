import { betaVersion, isStableVersion, parseBetaTag } from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";

/**
 * Where a release's web app goes (ADR 0188, "The web app follows releases"), as a pure decision
 * over the tag, its commit and the releases already published. `scripts/pipeline/web-plan.ts`
 * reads those facts; the release workflow builds `apps/web` once and runs `wrangler pages deploy`
 * for each branch the plan names.
 *
 * - The Pages project's production branch, `main` (app.acehq.dev), serves stable releases only.
 * - The `beta` branch (beta.app.acehq.dev) serves the newest release of either line, as the Beta
 *   line's apps update (ADR 0177): a beta goes there only, and a stable release goes to both, so
 *   the beta site never trails stable.
 * - Each branch skips a release older than one of its lines already published, so rerunning an
 *   older unpublished tag never takes a site backwards.
 */

export const webPagesProject = "ace-web";

export type WebBranch = "main" | "beta";

export interface WebDeployFacts {
  /** `vX.Y.Z` or `ace-X.Y.Z-beta-N`, already checked by the workflow's gate. */
  tag: string;
  /** The full sha the gate checked and every job checked out. */
  commit: string;
  /** The tags of every published release (drafts excluded). Other tag shapes are ignored. */
  published: readonly string[];
}

export interface WebBranchDeploy {
  branch: WebBranch;
  /** Where people reach this branch. */
  site: string;
}

export interface WebDeployPlan {
  /** Stamped into the build as `ACE_VERSION`: the web app names itself `web/<version>`. */
  version: string;
  /** The deployments' message, as the Pages dashboard lists it. */
  message: string;
  /** The branches to deploy this build to, in order; none when every branch is ahead. */
  deploy: WebBranchDeploy[];
  /** The branches left alone, each with why. */
  skip: { branch: WebBranch; reason: string }[];
}

type Line = "stable" | "beta";

interface TagRelease {
  line: Line;
  version: string;
}

const commitSha = /^[0-9a-f]{40}$/;
const stableTag = /^v(.+)$/;

function releaseOf(tag: string): TagRelease | undefined {
  const beta = parseBetaTag(tag);
  if (beta) return { line: "beta", version: betaVersion(beta) };
  const stable = stableTag.exec(tag)?.[1];
  return stable !== undefined && isStableVersion(stable)
    ? { line: "stable", version: stable }
    : undefined;
}

/** Each branch: its site, and the lines it serves. */
const branches: readonly (WebBranchDeploy & { lines: readonly Line[] })[] = [
  { branch: "main", site: "https://app.acehq.dev", lines: ["stable"] },
  { branch: "beta", site: "https://beta.app.acehq.dev", lines: ["stable", "beta"] },
];

/** The newest of `versions` in semver order, or undefined for none. */
const newest = (versions: readonly string[]) =>
  versions.reduce<string | undefined>(
    (latest, version) => (latest && !isNewer(version, latest) ? latest : version),
    undefined,
  );

/** What to do with `facts.tag`'s web app; throws for a tag or commit no release can have. */
export function webDeployPlan(facts: WebDeployFacts): WebDeployPlan {
  const release = releaseOf(facts.tag);
  if (!release) throw new Error(`${facts.tag} is neither vX.Y.Z nor ace-X.Y.Z-beta-N`);
  if (!commitSha.test(facts.commit)) throw new Error(`"${facts.commit}" isn't a full commit sha`);
  const published = facts.published.flatMap((tag) => releaseOf(tag) ?? []);
  const plan: WebDeployPlan = {
    version: release.version,
    message: `ace ${facts.tag}`,
    deploy: [],
    skip: [],
  };
  for (const { branch, site, lines } of branches) {
    if (!lines.includes(release.line)) continue;
    const later = newest(
      published
        .filter((other) => lines.includes(other.line) && isNewer(other.version, release.version))
        .map((other) => other.version),
    );
    if (later)
      plan.skip.push({
        branch,
        reason: `${later} is already published, so ${site} stays on it rather than going back to ${release.version}`,
      });
    else plan.deploy.push({ branch, site });
  }
  return plan;
}
