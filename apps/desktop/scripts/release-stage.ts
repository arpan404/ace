import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, checksumList, StagedRelease } from "../src/packaging/release-plan.ts";
import { releaseDataFile, renderReleaseData } from "../src/packaging/release-data.ts";
import { ReleaseTarget } from "@ace/protocol";
import { stagedSpade } from "@ace/release/spade";
import { dist, repo } from "./common.ts";
import { releaseDataAt } from "./release-data.ts";
import { sha256 } from "./release-tools.ts";

/**
 * The steps every desktop release shares, stable (`release.ts`) or beta (`release-beta.ts`):
 * verifying the packaged Mac app, staging its files with their hashes and `ace-data.json`, and
 * checking a staged folder before it is published.
 */

export const say = (line: string) => console.log(`[release] ${line}`);
export const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(file, args, { cwd: repo, stdio: "inherit", env });

/** The packaged app's signature, Gatekeeper's verdict and the stapled ticket; returns the app. */
export function verifyMac(output: string, signed: boolean): string {
  const folder = ["mac-arm64", "mac", "mac-universal"].find((name) =>
    existsSync(join(output, name, "ace.app")),
  );
  if (!folder) throw new Error(`No ace.app in ${output}`);
  const app = join(output, folder, "ace.app");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (!signed) return app;
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  run("xcrun", ["stapler", "validate", app]);
  say("signature, Gatekeeper and notarization ticket verified");
  return app;
}

/** The Spade server the package just built carries: staged in dist for this host's target. */
export function shippedSpade(): string {
  return stagedSpade(dist, ReleaseTarget.parse(`${process.platform}-${process.arch}`));
}

export interface StageInput {
  /** The folder the release is staged in; emptied first. */
  target: string;
  /** Each source folder with the file names to copy from it. */
  sources: readonly (readonly [folder: string, names: readonly string[]])[];
  release: Omit<StagedRelease, "files">;
  /** The Spade server this release ships, asked for its schema version (`ace-data.json`). */
  spadeBinary: string;
}

/**
 * Copies the release's files into `target` with their sizes and SHA-256, adds `ace-data.json`
 * (this tree's data formats, ADR 0174), and writes `release.json` and `SHA256SUMS`.
 */
export async function stageRelease(input: StageInput): Promise<StagedRelease> {
  const { target } = input;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const files: StagedRelease["files"] = [];
  const record = async (name: string) => {
    const path = join(target, name);
    files.push({ name, bytes: (await stat(path)).size, sha256: await sha256(path) });
  };
  for (const [from, names] of input.sources)
    for (const name of names) {
      await copyFile(join(from, name), join(target, name));
      await record(name);
    }
  await writeFile(
    join(target, releaseDataFile),
    renderReleaseData(await releaseDataAt(repo, input.spadeBinary)),
  );
  await record(releaseDataFile);
  const release: StagedRelease = { ...input.release, files };
  await writeFile(join(target, "release.json"), JSON.stringify(release, null, 2) + "\n");
  await writeFile(join(target, "SHA256SUMS"), checksumList(release));
  for (const file of files) say(`${file.name}  ${(file.bytes / 1e6).toFixed(1)} MB`);
  say(`staged in ${target}`);
  return release;
}

/**
 * A staged folder's release, after checking every file still has the bytes the build recorded.
 * `paths` maps each file name to where it is on disk.
 */
export async function readStaged(
  folder: string,
  missing: string,
): Promise<{ release: StagedRelease; paths: Map<string, string> }> {
  const manifest = join(folder, "release.json");
  if (!existsSync(manifest)) throw new Error(missing);
  const release = StagedRelease.parse(JSON.parse(await readFile(manifest, "utf8")));
  const actual = new Map<string, string | undefined>();
  const paths = new Map<string, string>();
  for (const file of release.files) {
    const path = join(folder, file.name);
    actual.set(file.name, existsSync(path) ? await sha256(path) : undefined);
    paths.set(file.name, path);
  }
  const changed = changedFiles(release, actual);
  if (changed.length)
    throw new Error(`Staged files in ${folder} changed since the build: ${changed.join(", ")}`);
  return { release, paths };
}
