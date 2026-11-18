#!/usr/bin/env node
import { remoteTagNames } from "../../src/packaging/beta-plan.ts";
import { releasePlatforms, resumePlan } from "../../src/packaging/release-resume.ts";
import { releaseForTag } from "../../src/packaging/release-tag.ts";
import {
  attempt,
  checkedOutAppVersion,
  gh,
  output,
  releaseState,
  run,
  say,
  step,
  summary,
  tagArgument,
  tagCommit,
  uploadedManifests,
} from "./github.ts";

/**
 * The release pipeline's first step (ADR 0188), on omarchy with the tag checked out:
 *
 *   node apps/desktop/scripts/pipeline/prepare.ts <tag>
 *
 * Checks the tag (its commit is on origin/main; a beta follows ADR 0177's numbering; a stable
 * tag matches apps/desktop/package.json), makes sure the tag has a draft release to build into,
 * and works out what this run still has to do from what the draft already holds. Outputs:
 * `kind`, `version`, `title`, `commit`, `published`, `build-<platform>` for each platform, and `linux-arches`.
 */
step(async () => {
  const tag = tagArgument();
  const commit = tagCommit(tag);
  run("git", ["fetch", "--quiet", "origin", "main"]);
  const onMain = attempt("git", ["merge-base", "--is-ancestor", commit, "origin/main"]).ok;
  const tags = remoteTagNames(run("git", ["ls-remote", "--tags", "origin"]));
  const verdict = releaseForTag({ tag, onMain, appVersion: checkedOutAppVersion(), tags });
  if (!verdict.ok) throw new Error(`${tag} can't be released:\n${verdict.problems.join("\n")}`);
  const { release } = verdict;
  say(`${release.title} (${release.kind}) as ${release.version} from ${commit.slice(0, 12)}`);

  let state = releaseState(tag);
  if (!state.exists) {
    // A draft first, created from the tag the owner pushed: nobody sees it until publish.
    gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      "--title",
      release.title,
      "--notes",
      "",
      ...(release.kind === "beta" ? ["--prerelease", "--latest=false"] : []),
    ]);
    state = releaseState(tag);
    say(`created the draft release for ${tag}`);
  }
  const plan = resumePlan({ state, commit, manifests: await uploadedManifests(tag, state) });

  output("kind", release.kind);
  output("version", release.version);
  output("title", release.title);
  output("commit", commit);
  output("published", String(plan.published));
  for (const platform of releasePlatforms)
    output(`build-${platform}`, String(plan.build.includes(platform)));
  // The Linux matrix: the architectures still to build, as a JSON list.
  const linux = plan.build.flatMap((platform) =>
    platform.startsWith("linux-") ? [platform.slice(6)] : [],
  );
  output("linux-arches", JSON.stringify(linux));

  const done = releasePlatforms.filter((platform) => !plan.build.includes(platform));
  summary(
    plan.published
      ? `**${release.title}** is already published; this run only finishes what follows it.`
      : `**${release.title}** from \`${commit.slice(0, 12)}\`. Building: ${plan.build.join(", ") || "nothing"}. Already uploaded: ${done.join(", ") || "nothing"}.`,
  );
});
