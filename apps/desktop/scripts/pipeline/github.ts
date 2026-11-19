import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { releaseRepository, StagedRelease } from "../../src/packaging/release-plan.ts";
import {
  isManifestAsset,
  ReleaseAsset,
  releasePlatforms,
  type ReleasePlatform,
  type ReleaseState,
} from "../../src/packaging/release-resume.ts";
import { repo } from "../common.ts";

/**
 * The GitHub and git I/O the release pipeline's steps share (ADR 0188): reading a tag's release
 * and the staged manifests uploaded to it, and writing step outputs. Every decision is made by
 * the pure modules in `src/packaging`.
 */

export const say = (line: string) => console.log(`[pipeline] ${line}`);

/** Runs a command and returns its stdout; a failure throws with its stderr. */
export function run(command: string, args: readonly string[], input?: string): string {
  return execFileSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Runs a command and reports whether it exited 0, with its output. */
export function attempt(command: string, args: readonly string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export const gh = (args: readonly string[], input?: string) =>
  run("gh", [...args, "--repo", releaseRepository], input);

/** The tag named on the command line, as GitHub Actions passes it. */
export function tagArgument(): string {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: <script> <tag>");
  return tag;
}

/** The commit a tag points at, peeled through an annotated tag. */
export function tagCommit(tag: string): string {
  return run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]).trim();
}

const ReleaseView = z.object({
  isDraft: z.boolean(),
  body: z.string().nullish(),
  assets: z.array(ReleaseAsset),
});

/** The tag's GitHub release, drafts included. */
export function releaseState(tag: string): ReleaseState {
  const view = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", releaseRepository, "--json", "isDraft,body,assets"],
    { cwd: repo, encoding: "utf8" },
  );
  if (view.status !== 0) {
    if (/release not found/i.test(view.stderr ?? "")) return { exists: false };
    throw new Error(`gh release view ${tag} failed: ${view.stderr}`);
  }
  const release = ReleaseView.parse(JSON.parse(view.stdout));
  return { exists: true, draft: release.isDraft, body: release.body ?? "", assets: release.assets };
}

/** The staged manifests (`staged-<platform>.json`) uploaded to the tag's release. */
export async function uploadedManifests(
  tag: string,
  state: ReleaseState,
): Promise<Map<ReleasePlatform, StagedRelease>> {
  const manifests = new Map<ReleasePlatform, StagedRelease>();
  if (!state.exists || !state.assets.some((asset) => isManifestAsset(asset.name))) return manifests;
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP ?? repo, "ace-manifests-"));
  gh(["release", "download", tag, "--pattern", "staged-*.json", "--dir", folder, "--clobber"]);
  const names = new Set(await readdir(folder));
  for (const platform of releasePlatforms) {
    const name = `staged-${platform}.json`;
    if (!names.has(name)) continue;
    const parsed = StagedRelease.safeParse(JSON.parse(await readFile(join(folder, name), "utf8")));
    // A manifest this pipeline can't read is treated as absent: that platform builds again.
    if (parsed.success) manifests.set(platform, parsed.data);
    else say(`ignoring ${name}: ${parsed.error.message}`);
  }
  return manifests;
}

/** Sets a step output for later jobs (`$GITHUB_OUTPUT`); printed when run by hand. */
export function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  say(`${name}=${value}`);
}

/** Adds Markdown to the run's summary page (`$GITHUB_STEP_SUMMARY`). */
export function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** `apps/desktop/package.json`'s version in the checked-out tree. */
export function checkedOutAppVersion(): string {
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(repo, "apps/desktop/package.json"), "utf8")));
  return manifest.version;
}

/** Runs `main` and turns a thrown error into a failed step with its message. */
export function step(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message.replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  });
}
