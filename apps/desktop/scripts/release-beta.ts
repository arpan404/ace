#!/usr/bin/env node
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betaTitle, parseBetaTag } from "@ace/service/release-line";
import {
  betaHostProblem,
  planBeta,
  remoteTagNames,
  stagedBeta,
} from "../src/packaging/beta-plan.ts";
import {
  checksumList,
  desktopAssets,
  missingUpdatePackages,
  releaseRepository,
} from "../src/packaging/release-plan.ts";
import { notaryCredentials } from "../src/packaging/release-signing.ts";
import { appVersion, desktop, dist, repo } from "./common.ts";
import { checkPackagedLaunch } from "./launch-check.ts";
import { readStaged, run, say, shippedSpade, stageRelease, verifyMac } from "./release-stage.ts";
import {
  capture,
  githubReady,
  headCommit,
  signingIdentity,
  untrackedFiles,
  worktreeClean,
} from "./release-tools.ts";

/**
 * Beta releases of the desktop app (ADR 0174): a signed, notarized macOS arm64 build of a commit
 * on `origin/main`, published as a GitHub prerelease tagged `ace-beta-<date>-<X.Y.Z>-<N>` and
 * never marked latest. Installed apps on the Beta line pick it up.
 *
 *   bun run release:beta build [--version 0.1.0]
 *   bun run release:beta publish [<tag>] [--notes-file notes.md]
 *
 * A beta previews the next version: the patch after `apps/desktop/package.json`, or a later
 * `--version`. `build` works out the tag and the app's version (`X.Y.Z-beta.<YYYYMMDD>.<N>`), sets that
 * version for this build only (package.json is never edited), packages and verifies the app,
 * and stages the dmg, zip, `latest-mac.yml`, `ace-data.json` and their hashes under
 * `dist/releases/<tag>`. `publish` checks the staged hashes and that the commit is on
 * `origin/main`, uploads a draft prerelease, then publishes it, so no app sees a half-uploaded
 * beta. There is no unsigned beta: Squirrel.Mac installs only what the running app's
 * Developer ID signed.
 */
const usage = `Usage:
  bun run release:beta build [--version <X.Y.Z>]
  bun run release:beta publish [<tag>] [--notes-file <path>]`;

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
const releases = join(repo, "dist/releases");

try {
  if (command === "build" && (rest.length === 0 || (rest.length === 2 && option("--version"))))
    await build(option("--version"));
  else if (command === "publish") await publish(rest[0]?.startsWith("--") ? undefined : rest[0]);
  else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

/** Whether `commit` is on GitHub's `main`, fetched just now. */
function onMain(commit: string): boolean {
  capture("git", ["fetch", "--quiet", "origin", "main"]);
  return capture("git", ["merge-base", "--is-ancestor", commit, "origin/main"]).ok;
}

function tagExists(tag: string): boolean {
  return capture("gh", ["release", "view", tag, "--repo", releaseRepository]).ok;
}

async function build(version: string | undefined): Promise<void> {
  const host = betaHostProblem(process.platform, process.arch);
  if (host) throw new Error(host);
  if (!worktreeClean()) throw new Error("Commit your changes first: a beta is built from main.");
  const untracked = untrackedFiles();
  if (untracked.length)
    throw new Error(
      `Untracked files would ship in the beta; remove them or build in a fresh worktree: ${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? ` and ${untracked.length - 5} more` : ""}`,
    );
  const commit = headCommit();
  if (!onMain(commit))
    throw new Error(`${commit.slice(0, 12)} is not on origin/main; betas are built from main.`);
  const identity = signingIdentity(process.env);
  if (!identity.ok) throw new Error(`${identity.problem}. A beta is always signed.`);
  const notary = notaryCredentials(process.env);
  if (notary.kind === "none" || notary.kind === "incomplete")
    throw new Error("No notarization credentials: run bun run release:doctor for what to set.");
  const tags = capture("git", ["ls-remote", "--tags", "origin"]);
  if (!tags.ok) throw new Error(`Couldn't list GitHub's tags: ${tags.out}`);
  const plan = planBeta({
    stable: appVersion(),
    version,
    now: Date.now(),
    tags: remoteTagNames(tags.out),
  });
  if (githubReady() && tagExists(plan.tag))
    throw new Error(`${plan.tag} already exists on GitHub.`);
  say(`${plan.title} as ${plan.version} from ${commit.slice(0, 12)}`);
  say(`signing as ${identity.name}, notarizing with ${notary.kind}`);

  run(process.execPath, [join(desktop, "scripts/package.ts"), "--full"], {
    ...process.env,
    ACE_VERSION: plan.version,
  });
  const output = join(dist, "release");
  const app = verifyMac(output, true);
  say("launching the packaged app with an empty data home");
  await checkPackagedLaunch(app);
  say("packaged app started its daemon and checked for updates");

  const files = desktopAssets(await readdir(output), plan.version);
  const missing = missingUpdatePackages(files);
  if (!files.includes("latest-mac.yml")) missing.push("latest-mac.yml");
  if (!files.some((name) => name.endsWith(".dmg"))) missing.push("dmg");
  if (missing.length) throw new Error(`The build made no ${missing.join(", ")}`);
  await stageRelease({
    target: join(releases, plan.tag),
    sources: [[output, files]],
    spadeBinary: shippedSpade(),
    release: {
      version: plan.version,
      tag: plan.tag,
      commit,
      dirty: false,
      signed: true,
      notarized: true,
    },
  });
  say(`next: bun run release:beta publish ${plan.tag}`);
}

async function publish(wanted: string | undefined): Promise<void> {
  const folders = existsSync(releases) ? await readdir(releases) : [];
  const tag = stagedBeta(folders, wanted);
  const name = parseBetaTag(tag);
  if (!name) throw new Error(`${tag} is not a beta tag`);
  const { release, paths } = await readStaged(join(releases, tag), `No staged beta in ${tag}`);
  if (release.tag !== tag) throw new Error(`dist/releases/${tag} holds ${release.tag}`);
  if (release.dirty || !release.signed || !release.notarized)
    throw new Error("A beta must be a signed, notarized build of a commit; rebuild it.");
  if (!githubReady()) throw new Error("Sign in to GitHub first: gh auth login");
  if (!onMain(release.commit))
    throw new Error(`${release.commit.slice(0, 12)} is not on origin/main; the tag points at it.`);
  if (tagExists(tag)) throw new Error(`${tag} already exists on GitHub.`);
  const checksums = join(await mkdtemp(join(tmpdir(), "ace-beta-")), "SHA256SUMS");
  await writeFile(checksums, checksumList(release));
  const notes = option("--notes-file");
  // A draft first: installed apps never see a beta whose files are still uploading.
  run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    releaseRepository,
    "--target",
    release.commit,
    "--title",
    betaTitle(name),
    ...(notes ? ["--notes-file", notes] : ["--generate-notes"]),
    "--draft",
    "--prerelease",
    "--latest=false",
    ...release.files.map((file) => paths.get(file.name) ?? file.name),
    checksums,
  ]);
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    releaseRepository,
    "--draft=false",
    "--prerelease",
    "--latest=false",
  ]);
  const url = capture("gh", [
    "release",
    "view",
    tag,
    "--repo",
    releaseRepository,
    "--json",
    "url",
    "--jq",
    ".url",
  ]).out;
  say(`published: ${url}`);
}
