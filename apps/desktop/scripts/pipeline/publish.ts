#!/usr/bin/env node
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBetaTag } from "@ace/service/release-line";
import { isManifestAsset, publishVerdict } from "../../src/packaging/release-resume.ts";
import {
  gh,
  releaseState,
  say,
  step,
  summary,
  tagArgument,
  tagCommit,
  uploadedManifests,
} from "./github.ts";

/**
 * Makes the tag's draft release live for everyone (ADR 0188), on omarchy:
 *
 *   node apps/desktop/scripts/pipeline/publish.ts <tag> <version>
 *
 * Only when every platform uploaded a build of the tag's commit and version, the macOS build is
 * signed and notarized, and every file is on the draft with the bytes its build recorded. Adds
 * `SHA256SUMS`, then publishes: a stable release is marked latest, a beta is a prerelease that
 * only the Beta line picks up (ADR 0177). The staged manifests are removed afterwards. A release
 * that is already published only has its manifests cleaned up.
 */
step(async () => {
  const tag = tagArgument();
  const version = process.argv[3];
  if (!version) throw new Error("Usage: publish.ts <tag> <version>");
  let state = releaseState(tag);
  if (!state.exists) throw new Error(`${tag} has no release; run prepare first`);
  if (state.draft) {
    if (!state.body.trim()) throw new Error(`${tag}'s draft has no notes yet`);
    const verdict = publishVerdict({
      assets: state.assets,
      commit: tagCommit(tag),
      version,
      manifests: await uploadedManifests(tag, state),
    });
    if (!verdict.ok) throw new Error(`${tag} can't be published:\n${verdict.problems.join("\n")}`);
    const sums = join(
      await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ace-sums-")),
      "SHA256SUMS",
    );
    await writeFile(sums, verdict.checksums);
    gh(["release", "upload", tag, sums, "--clobber"]);
    const beta = parseBetaTag(tag) !== undefined;
    gh([
      "release",
      "edit",
      tag,
      "--draft=false",
      ...(beta ? ["--prerelease", "--latest=false"] : ["--prerelease=false", "--latest"]),
    ]);
    say(`published ${tag} with ${verdict.release.files.length} files`);
    state = releaseState(tag);
  } else say(`${tag} is already published`);

  if (state.exists)
    for (const { name } of state.assets)
      if (isManifestAsset(name)) gh(["release", "delete-asset", tag, name, "--yes"]);
  const url = gh(["release", "view", tag, "--json", "url", "--jq", ".url"]).trim();
  summary(`**${tag}** is live: ${url}`);
});
