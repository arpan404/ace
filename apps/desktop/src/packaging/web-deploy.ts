import { betaVersion, isStableVersion, parseBetaTag } from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";

/**
 * Where a release's web app goes (ADR 0188, "The web app"), as a pure decision over the tag, its
 * commit and the releases already published. `scripts/pipeline/web-plan.ts` reads those facts;
 * the release workflow builds `apps/web` and runs `wrangler pages deploy` with the result.
 *
 * - A stable tag deploys to the Pages project's production branch, `main`: app.acehq.dev.
 * - A beta tag deploys to the `beta` branch (beta.ace-web.pages.dev); app.acehq.dev is untouched.
 * - Either is skipped when a later release of its line is already published, so rerunning an
 *   older unpublished tag never takes the site backwards.
 */

export const webPagesProject = "ace-web";

export interface WebDeployFacts {
  /** `vX.Y.Z` or `ace-X.Y.Z-beta-N`, already checked by the workflow's gate. */
  tag: string;
  /** The full sha the gate checked and every job checked out. */
  commit: string;
  /** The tags of every published release (drafts excluded). Other tag shapes are ignored. */
  published: readonly string[];
}

export interface WebDeploy {
  action: "deploy";
  /** Stamped into the build as `ACE_VERSION`: the web app names itself `web/<version>`. */
  version: string;
  /** The Pages branch: `main` is production, `beta` a preview with its own alias. */
  branch: "main" | "beta";
  /** The deployment's message, as the Pages dashboard lists it. */
  message: string;
  /** Where people reach this deployment. */
  site: string;
}

export type WebDeployPlan = WebDeploy | { action: "skip"; reason: string };

const commitSha = /^[0-9a-f]{40}$/;
const stableTag = /^v(.+)$/;

interface TagRelease {
  line: "stable" | "beta";
  version: string;
}

function releaseOf(tag: string): TagRelease | undefined {
  const beta = parseBetaTag(tag);
  if (beta) return { line: "beta", version: betaVersion(beta) };
  const stable = stableTag.exec(tag)?.[1];
  return stable !== undefined && isStableVersion(stable)
    ? { line: "stable", version: stable }
    : undefined;
}

const target = {
  stable: { branch: "main", site: "https://app.acehq.dev" },
  beta: { branch: "beta", site: "https://beta.ace-web.pages.dev" },
} as const;

/** What to do with `facts.tag`'s web app; throws for a tag or commit no release can have. */
export function webDeployPlan(facts: WebDeployFacts): WebDeployPlan {
  const release = releaseOf(facts.tag);
  if (!release) throw new Error(`${facts.tag} is neither vX.Y.Z nor ace-X.Y.Z-beta-N`);
  if (!commitSha.test(facts.commit)) throw new Error(`"${facts.commit}" isn't a full commit sha`);
  const later = facts.published
    .map(releaseOf)
    .filter(
      (other): other is TagRelease =>
        other?.line === release.line && isNewer(other.version, release.version),
    )
    .map((other) => other.version)
    .reduce<string | undefined>(
      (latest, version) => (latest && !isNewer(version, latest) ? latest : version),
      undefined,
    );
  const { branch, site } = target[release.line];
  if (later)
    return {
      action: "skip",
      reason: `${later} is already published, so ${site} stays on it rather than going back to ${release.version}`,
    };
  return { action: "deploy", version: release.version, branch, message: `ace ${facts.tag}`, site };
}
