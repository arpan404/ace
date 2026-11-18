import { z } from "zod";

/*
 * The decisions behind a Worker release (docs/release/workers.md), pure: what is live and what
 * this release is in, what to do out. The shell in deploy-run.ts asks Cloudflare and acts.
 */

export const environments = ["staging", "production"] as const;
export type Environment = (typeof environments)[number];

/**
 * What the release workflow reads from the exit code:
 * - `deployed`: the release is live and its smoke passed, or it already was live.
 * - `unchanged`: refused or failed before the release went live; the previous version still
 *   serves. Migrations may have been applied (they only expand).
 * - `rolledBack`: the release went live, failed its smoke, and the previous version is back and
 *   passed its own smoke.
 * - `needsHuman`: the release went live, failed, and ace couldn't get back to a healthy previous
 *   version. Someone must act now.
 * - `usage`: bad arguments.
 */
export const exitCodes = {
  deployed: 0,
  unchanged: 1,
  rolledBack: 2,
  needsHuman: 3,
  usage: 64,
} as const;
export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];

/** One release of a Worker: its version tag and the message its version carries. */
export interface Release {
  tag: string;
  commit: string;
  message: string;
}

const releaseTag = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const commitSha = /^[0-9a-f]{40}$/;

/** The release for a tag (or, without one, for the commit alone) at a full commit sha. */
export function releaseFor(tag: string | undefined, commit: string): Release {
  if (!commitSha.test(commit)) throw new Error(`"${commit}" isn't a full commit sha`);
  const name = tag ?? `git-${commit.slice(0, 12)}`;
  if (!releaseTag.test(name)) throw new Error(`"${name}" isn't a usable release tag`);
  return { tag: name, commit, message: `ace ${name} (${commit})` };
}

/** A Worker version as Cloudflare describes it. */
export interface VersionInfo {
  id: string;
  tag?: string | undefined;
  message?: string | undefined;
}

/** What serves a Worker's traffic now. */
export type Live =
  | { kind: "none" }
  | { kind: "single"; version: VersionInfo }
  | { kind: "split"; versionIds: string[] };

/** Whether this version was uploaded for this release. */
export const isRelease = (version: VersionInfo, release: Release) =>
  version.tag === release.tag && (version.message?.includes(release.commit) ?? false);

export type StartDecision =
  | { action: "skip"; versionId: string }
  | { action: "deploy"; previous: string | undefined }
  | { action: "refuse"; reason: string };

/**
 * Before deploying: nothing to do if this release already serves all traffic; refuse if traffic is
 * split, since there'd be no single version to return to; otherwise deploy, remembering what
 * serves now.
 */
export function decideStart(live: Live, release: Release): StartDecision {
  switch (live.kind) {
    case "none":
      return { action: "deploy", previous: undefined };
    case "single":
      return isRelease(live.version, release)
        ? { action: "skip", versionId: live.version.id }
        : { action: "deploy", previous: live.version.id };
    case "split":
      return {
        action: "refuse",
        reason: `traffic is split between ${live.versionIds.join(" and ")}; finish or roll back that deployment first`,
      };
  }
}

/** Production waits for staging to run this release (unless told otherwise). */
export function stagingGate(staging: Live, release: Release): string | undefined {
  if (staging.kind === "single" && isRelease(staging.version, release)) return undefined;
  return `staging isn't running ${release.tag} (${release.commit.slice(0, 12)}); deploy staging first`;
}

export type AfterDeploy =
  | { state: "unchanged" }
  | { state: "live"; versionId: string }
  | { state: "unknown" };

/**
 * After the deploy command, from what serves now: the previous version still (the deploy never
 * took), this release, or anything else, which is treated as a failed release.
 */
export function readAfterDeploy(
  live: Live,
  previous: string | undefined,
  release: Release,
): AfterDeploy {
  if (live.kind === "single" && isRelease(live.version, release))
    return { state: "live", versionId: live.version.id };
  if (live.kind === "none" && previous === undefined) return { state: "unchanged" };
  if (live.kind === "single" && live.version.id === previous) return { state: "unchanged" };
  return { state: "unknown" };
}

export interface CustomDomainRoute {
  pattern: string;
  custom_domain?: boolean;
}

/** The origins to smoke: every custom domain the environment serves. */
export function smokeOrigins(routes: readonly (string | CustomDomainRoute)[]): string[] {
  return routes
    .filter((route): route is CustomDomainRoute => typeof route !== "string")
    .filter((route) => route.custom_domain === true)
    .map((route) => `https://${route.pattern}`);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const developmentId = /^00000000-0000-/;

/** Why this environment's resources aren't ready to deploy: placeholder or development ids. */
export function configProblems(
  databases: readonly { binding: string; database_id?: string | undefined }[],
): string[] {
  return databases
    .filter(
      (db) => !db.database_id || !uuid.test(db.database_id) || developmentId.test(db.database_id),
    )
    .map(
      (db) =>
        `${db.binding} has database_id "${db.database_id ?? ""}"; set the id \`wrangler d1 create\` printed`,
    );
}

/*
 * Wrangler's JSON output. Decoded leniently: unknown fields are ignored, and a banner or warning
 * printed around the JSON is skipped.
 */

const DeploymentJson = z.object({
  versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })),
});
const VersionJson = z.object({
  id: z.string(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

function jsonIn(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("wrangler printed no JSON");
  return JSON.parse(output.slice(start, end + 1));
}

/** The version ids serving traffic, from `wrangler deployments status --json`. */
export function parseDeployment(output: string): { versionId: string; percentage: number }[] {
  return DeploymentJson.parse(jsonIn(output)).versions.map((entry) => ({
    versionId: entry.version_id,
    percentage: entry.percentage,
  }));
}

/** A version's tag and message, from `wrangler versions view --json`. */
export function parseVersion(output: string): VersionInfo {
  const version = VersionJson.parse(jsonIn(output));
  const text = (key: string) => {
    const value = version.annotations?.[key];
    return typeof value === "string" ? value : undefined;
  };
  return { id: version.id, tag: text("workers/tag"), message: text("workers/message") };
}

/** Whether a failed `wrangler deployments status` means the Worker was never deployed. */
export const neverDeployed = (output: string) => /has no deployments|\[code: 10007\]/.test(output);
