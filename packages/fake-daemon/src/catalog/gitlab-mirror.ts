import { sketchPullRequests, type PrSketch } from "./forge-browse.ts";
import type { PullRequestFixture } from "./pull-request-details.ts";

/*
 * Merge requests on `ace`'s GitLab mirror (gitlab.com/acme/ace, the `mirror` remote), distinct
 * from its GitHub reviews: numbers, titles and authors of their own, so a list reading both
 * repositories shows each once and a test can tell which repository a row came from.
 */

const minute = 60_000;
const hour = 60 * minute;

const sketches: PrSketch[] = [
  {
    number: 17,
    title: "Mirror CI: run the release checks on GitLab runners",
    state: "open",
    author: "lee",
    reviewers: ["you"],
    decision: "REVIEW_REQUIRED",
    ci: "success",
    updated: 25 * minute,
    labels: ["ci"],
    branch: "ci/gitlab-runners",
    body: "Runs the release checks on the mirror's runners so a GitHub outage doesn't block a release.",
    files: [[".gitlab-ci.yml", 64, 0]],
  },
  {
    number: 18,
    title: "Sync tags to the mirror after each release",
    state: "draft",
    author: "you",
    reviewers: [],
    ci: "pending",
    updated: 5 * hour,
    branch: "release/mirror-tags",
    body: "Pushes release tags to the mirror once the GitHub release is published.",
    files: [["scripts/release/mirror.ts", 41, 6]],
  },
];

const github = '{"forge":"github","host":"github.com","owner":"acme","name":"ace"}';
const gitlab = '{"forge":"gitlab","host":"gitlab.com","owner":"acme","name":"ace"}';

/** The mirror's merge requests, as GitLab lists them. */
export function gitlabMirrorPullRequests(now: number): PullRequestFixture[] {
  return sketchPullRequests(now, sketches).map((fixture): PullRequestFixture =>
    JSON.parse(
      JSON.stringify(fixture)
        .replaceAll(github, gitlab)
        .replace(
          /https:\/\/github\.com\/acme\/ace\/pull\/(\d+)/g,
          (_, n: string) => `https://gitlab.com/acme/ace/-/merge_requests/${n}`,
        )
        .replaceAll("https://github.com/acme/ace", "https://gitlab.com/acme/ace"),
    ),
  );
}
