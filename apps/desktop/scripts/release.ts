#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseVersion } from "@ace/protocol";
import {
  changedFiles,
  checksumList,
  daemonAssets,
  desktopAssets,
  isPrerelease,
  missingUpdatePackages,
  releaseRepository,
  releaseTag,
  StagedRelease,
} from "../src/packaging/release-plan.ts";
import { notaryCredentials } from "../src/packaging/release-signing.ts";
import { appVersion, desktop, dist, repo } from "./common.ts";
import {
  capture,
  githubReady,
  headCommit,
  pushed,
  releaseChecks,
  releaseExists,
  sha256,
  signingIdentity,
  worktreeClean,
} from "./release-tools.ts";

/**
 * Desktop releases built, signed and notarized on this Mac and published as a GitHub release,
 * which every installed app's updater reads (ADR 0091).
 *
 *   bun run release:doctor
 *   bun run release:build 0.0.3 [--unsigned] [--with-daemon] [--allow-dirty]
 *   bun run release:publish 0.0.3 [--draft] [--notes-file notes.md]
 *
 * `build` packages the app for this Mac's architecture (dmg, the zip Squirrel.Mac updates
 * from, blockmaps and `latest-mac.yml`), verifies its signature, notarization and staple, and
 * stages the files with their SHA-256 under `dist/releases/v<version>`. `--with-daemon` adds
 * the signed standalone daemon archives for both macOS architectures, so `ace update` on
 * standalone installs sees the release too. `publish` uploads exactly those staged files to a
 * draft release tagged at the built commit, then publishes it.
 */
const usage = `Usage:
  bun run release:doctor
  bun run release:build <version> [--unsigned] [--with-daemon] [--allow-dirty]
  bun run release:publish <version> [--draft] [--notes-file <path>]`;

const [command, versionArgument, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
const say = (line: string) => console.log(`[release] ${line}`);
const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(file, args, { cwd: repo, stdio: "inherit", env });
const staging = (version: string) => join(repo, "dist/releases", releaseTag(version));
const daemonOutput = join(repo, "tools/release/dist");
const daemonTargets = ["darwin-arm64", "darwin-x64"] as const;

try {
  if (command === "doctor") doctor();
  else if (command === "build" && versionArgument) await build(releaseVersion(versionArgument));
  else if (command === "publish" && versionArgument) await publish(releaseVersion(versionArgument));
  else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

/**
 * The version being released: valid semver that matches `apps/desktop/package.json`, so the
 * build, its file names and the tag all agree. Bump the version in a PR first.
 */
function releaseVersion(value: string): string {
  const version = value.replace(/^v/, "");
  if (!ReleaseVersion.safeParse(version).success)
    throw new Error(`${value} is not a release version: use semver like 0.0.3 or 0.1.0-preview.1`);
  const manifest = appVersion();
  if (version !== manifest)
    throw new Error(`apps/desktop/package.json is at ${manifest}; bump it to ${version} first`);
  return version;
}

function doctor(): void {
  const checks = releaseChecks(process.env);
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  const ready = (need: string) => checks.every((check) => check.ok || check.for !== need);
  const base = ready("any") && ready("publish");
  console.log("");
  if (base && ready("signed")) console.log("Ready for a signed, notarized release.");
  else if (base)
    console.log("Ready for an --unsigned release (macOS installs update by download).");
  else console.log("Not ready to publish yet: fix the ✗ items above.");
  if (!ready("daemon")) console.log("--with-daemon needs the daemon release keys and pinned Node.");
}

async function build(version: string): Promise<void> {
  const unsigned = flag("--unsigned");
  const withDaemon = flag("--with-daemon");
  const dirty = !worktreeClean();
  if (dirty && !flag("--allow-dirty"))
    throw new Error("Commit your changes first: a release is built from a commit.");
  if (githubReady() && releaseExists(version))
    throw new Error(`${releaseTag(version)} is already released; pick a newer version.`);
  const signed = process.platform === "darwin" && !unsigned;
  if (signed) {
    const identity = signingIdentity(process.env);
    if (!identity.ok) throw new Error(`${identity.problem}. Use --unsigned until you have one.`);
    const notary = notaryCredentials(process.env);
    if (notary.kind === "none" || notary.kind === "incomplete")
      throw new Error("No notarization credentials: run bun run release:doctor for what to set.");
    say(`signing as ${identity.name}, notarizing with ${notary.kind}`);
  } else say("ad-hoc signed and not notarized (--unsigned)");
  const publicKey = process.env.ACE_RELEASE_PUBLIC_KEY_FILE;
  const privateKey = process.env.ACE_RELEASE_PRIVATE_KEY_FILE;
  if (withDaemon && (!publicKey || !privateKey))
    throw new Error(
      "--with-daemon needs ACE_RELEASE_PUBLIC_KEY_FILE and ACE_RELEASE_PRIVATE_KEY_FILE",
    );

  const commit = headCommit();
  say(`ace ${version} from ${commit.slice(0, 12)}${dirty ? " (uncommitted changes)" : ""}`);
  run(
    process.execPath,
    [join(desktop, "scripts/package.ts"), "--full", ...(unsigned ? ["--unsigned"] : [])],
    { ...process.env, ACE_VERSION: version },
  );
  const output = join(dist, "release");
  if (process.platform === "darwin") verifyMac(output, signed);

  if (withDaemon && publicKey && privateKey)
    for (const target of daemonTargets) {
      run(process.execPath, [join(repo, "tools/release/src/build.ts"), version, target, publicKey]);
      run(process.execPath, [
        join(repo, "tools/release/src/sign.ts"),
        join(daemonOutput, `${target}.json`),
        privateKey,
        join(daemonOutput, `${target}.sig`),
      ]);
    }

  const desktopFiles = desktopAssets(await readdir(output), version);
  const missing = missingUpdatePackages(desktopFiles);
  if (missing.length) throw new Error(`The build made no ${missing.join(", ")}`);
  const daemonFiles = withDaemon
    ? daemonAssets(await readdir(daemonOutput), version, daemonTargets)
    : [];
  const target = staging(version);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const files: StagedRelease["files"] = [];
  for (const [from, names] of [
    [output, desktopFiles],
    [daemonOutput, daemonFiles],
  ] as const)
    for (const name of names) {
      await copyFile(join(from, name), join(target, name));
      const path = join(target, name);
      files.push({ name, bytes: (await stat(path)).size, sha256: await sha256(path) });
    }
  const release: StagedRelease = {
    version,
    tag: releaseTag(version),
    commit,
    dirty,
    signed,
    notarized: signed,
    files,
  };
  await writeFile(join(target, "release.json"), JSON.stringify(release, null, 2) + "\n");
  await writeFile(join(target, "SHA256SUMS"), checksumList(release));
  for (const file of files) say(`${file.name}  ${(file.bytes / 1e6).toFixed(1)} MB`);
  say(`staged in ${target}`);
  if (!signed)
    say("unsigned: installed Macs see this update and download it from the release page");
  say(`next: bun run release:publish ${version}`);
}

/** The packaged app's signature, Gatekeeper's verdict and the stapled ticket. */
function verifyMac(output: string, signed: boolean): void {
  const folder = ["mac-arm64", "mac", "mac-universal"].find((name) =>
    existsSync(join(output, name, "ace.app")),
  );
  if (!folder) throw new Error(`No ace.app in ${output}`);
  const app = join(output, folder, "ace.app");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (!signed) return;
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  run("xcrun", ["stapler", "validate", app]);
  say("signature, Gatekeeper and notarization ticket verified");
}

async function publish(version: string): Promise<void> {
  const folder = staging(version);
  const manifest = join(folder, "release.json");
  if (!existsSync(manifest))
    throw new Error(`Nothing staged for ${version}: run bun run release:build ${version} first.`);
  const release = StagedRelease.parse(JSON.parse(await readFile(manifest, "utf8")));
  if (release.version !== version) throw new Error(`${manifest} is for ${release.version}`);
  if (release.dirty)
    throw new Error("This build had uncommitted changes; rebuild from a commit to publish it.");
  const actual = new Map<string, string | undefined>();
  for (const file of release.files) {
    const path = join(folder, file.name);
    actual.set(file.name, existsSync(path) ? await sha256(path) : undefined);
  }
  const changed = changedFiles(release, actual);
  if (changed.length)
    throw new Error(`Staged files changed since the build: ${changed.join(", ")}`);
  if (!githubReady()) throw new Error("Sign in to GitHub first: gh auth login");
  if (!pushed(release.commit))
    throw new Error(`Push ${release.commit.slice(0, 12)} to GitHub first: the tag points at it.`);
  if (releaseExists(version)) throw new Error(`${release.tag} already exists on GitHub.`);

  const notes = option("--notes-file");
  const prerelease = isPrerelease(version);
  // A draft first: installed apps never see a release whose files are still uploading.
  run("gh", [
    "release",
    "create",
    release.tag,
    "--repo",
    releaseRepository,
    "--target",
    release.commit,
    "--title",
    `ace ${version}`,
    ...(notes ? ["--notes-file", notes] : ["--generate-notes"]),
    "--draft",
    ...(prerelease ? ["--prerelease"] : []),
    ...release.files.map((file) => join(folder, file.name)),
    join(folder, "SHA256SUMS"),
  ]);
  if (!flag("--draft"))
    run("gh", [
      "release",
      "edit",
      release.tag,
      "--repo",
      releaseRepository,
      "--draft=false",
      ...(prerelease ? [] : ["--latest"]),
    ]);
  const url = capture("gh", [
    "release",
    "view",
    release.tag,
    "--repo",
    releaseRepository,
    "--json",
    "url",
    "--jq",
    ".url",
  ]).out;
  say(flag("--draft") ? `draft ready for review: ${url}` : `published: ${url}`);
}
