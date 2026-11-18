#!/usr/bin/env node
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manifestAsset,
  missingAssets,
  releasePlatforms,
} from "../../src/packaging/release-resume.ts";
import { readStaged } from "../release-stage.ts";
import {
  gh,
  releaseState,
  say,
  step,
  tagArgument,
  tagCommit,
  uploadedManifests,
} from "./github.ts";

/**
 * Uploads the hosts' staged builds to the tag's draft release (ADR 0188), on omarchy:
 *
 *   node apps/desktop/scripts/pipeline/upload.ts <tag> <platform>=<staged folder>...
 *
 * Each folder is checked first (every file still has the bytes its build recorded, the build
 * is of the tag's commit). Only files the draft lacks or holds with other bytes are uploaded,
 * and the host's manifest, `staged-<platform>.json`, goes last: a manifest on the draft means
 * its files are all there. A file another platform already uploaded with other bytes stops
 * the upload; `ace-data.json` is the same on every host of one commit.
 */
step(async () => {
  const tag = tagArgument();
  const commit = tagCommit(tag);
  const parts = process.argv.slice(3).map((argument) => {
    const [name = "", folder = ""] = argument.split("=", 2);
    const platform = releasePlatforms.find((known) => known === name);
    if (!platform || !folder) throw new Error(`Expected <platform>=<folder>, not ${argument}`);
    return { platform, folder };
  });
  for (const { platform, folder } of parts) {
    const { release, paths } = await readStaged(folder, `Nothing staged in ${folder}`);
    if (release.commit !== commit)
      throw new Error(`${platform} was built from ${release.commit.slice(0, 12)}, not ${tag}`);
    const state = releaseState(tag);
    if (!state.exists || !state.draft) throw new Error(`${tag} has no draft release to upload to`);
    const others = await uploadedManifests(tag, state);
    others.delete(platform);
    for (const [other, manifest] of others) {
      const shared = new Map(manifest.files.map((file) => [file.name, file.sha256]));
      const clash = release.files.filter(
        (file) => shared.has(file.name) && shared.get(file.name) !== file.sha256,
      );
      if (clash.length)
        throw new Error(
          `${platform} and ${other} disagree on ${clash.map((f) => f.name).join(", ")}`,
        );
    }
    const manifest = manifestAsset(platform);
    // The old manifest goes first, so a stopped upload never looks complete.
    if (state.assets.some((asset) => asset.name === manifest))
      gh(["release", "delete-asset", tag, manifest, "--yes"]);
    const pending = missingAssets(state.assets, release);
    for (const name of pending) {
      say(`${platform}: uploading ${name}`);
      gh(["release", "upload", tag, paths.get(name) ?? name, "--clobber"]);
    }
    // The asset takes the file's name, so the manifest is copied under its own first.
    const named = join(
      await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ace-staged-")),
      manifest,
    );
    await copyFile(join(folder, "release.json"), named);
    gh(["release", "upload", tag, named, "--clobber"]);
    say(
      `${platform}: ${pending.length} uploaded, ${release.files.length - pending.length} already there`,
    );
  }
});
