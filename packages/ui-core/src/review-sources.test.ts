import { expect, test } from "vitest";
import { WorkspaceId, type ForgeRepository, type ProjectRepositories } from "@ace/protocol";
import { issueSources, reviewSources } from "./review-sources.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };

const entry = (
  repository: ForgeRepository,
  patch: { primary?: boolean; visible?: boolean } = {},
) => ({
  repository,
  source: "remote" as const,
  visible: patch.visible ?? true,
  primary: patch.primary ?? false,
  available: true,
});
const listed = (
  repositories: ProjectRepositories["repositories"],
  config: ProjectRepositories["config"] = null,
): ProjectRepositories => ({
  workspaceId: WorkspaceId.parse("ace"),
  repositories,
  primary: repositories.find((each) => each.primary)?.repository ?? null,
  config,
});

test("a project with a mirror reads its primary as before and names the mirror, both shown", () => {
  const lists = new Map([["ace", listed([entry(github, { primary: true }), entry(gitlab)])]]);
  expect(reviewSources(["ace"], lists)).toEqual([
    { project: "ace", shown: github },
    { project: "ace", repository: gitlab, shown: gitlab },
  ]);
});

test("a project whose repositories aren't known yet, or that has one, reads its primary alone", () => {
  const lists = new Map([["docs", listed([entry(github, { primary: true })])]]);
  expect(reviewSources(["api", "docs"], lists)).toEqual([{ project: "api" }, { project: "docs" }]);
});

test("a hidden repository isn't read, and hiding every one reads nothing", () => {
  const config = { added: [], hidden: [github], primary: gitlab };
  const one = new Map([
    ["ace", listed([entry(github, { visible: false }), entry(gitlab, { primary: true })], config)],
  ]);
  expect(reviewSources(["ace"], one)).toEqual([{ project: "ace" }]);
  const none = new Map([
    [
      "ace",
      listed([entry(github, { visible: false }), entry(gitlab, { visible: false })], {
        added: [],
        hidden: [github, gitlab],
        primary: null,
      }),
    ],
  ]);
  expect(reviewSources(["ace"], none)).toEqual([]);
});

test("issues are read from every repository whose host ace reads issues from", () => {
  const upstream = { ...github, owner: "upstream" };
  const lists = new Map([
    ["ace", listed([entry(github, { primary: true }), entry(gitlab), entry(upstream)])],
  ]);
  expect(issueSources(["ace"], lists)).toEqual([
    { project: "ace", shown: github },
    { project: "ace", repository: upstream, shown: upstream },
  ]);
});

test("a project whose only listed repositories are hidden lists no issues, as it lists no reviews", () => {
  const lists = new Map([
    [
      "ace",
      listed([entry(github, { primary: false, visible: false })], {
        added: [],
        hidden: [github],
        primary: null,
      }),
    ],
  ]);
  expect(issueSources(["ace"], lists)).toEqual([]);
  expect(reviewSources(["ace"], lists)).toEqual([]);
});

test("issues appear for a mirror declaring issue reads, and disappear when reads are withdrawn", () => {
  const lists = new Map([
    [
      "ace",
      listed([
        { ...entry(github, { primary: true }), capabilities: [] },
        { ...entry(gitlab), capabilities: ["reviews.read", "issues.read"] },
      ]),
    ],
  ]);
  expect(issueSources(["ace"], lists)).toEqual([{ project: "ace", repository: gitlab }]);
  expect(reviewSources(["ace"], lists)).toEqual([{ project: "ace", repository: gitlab }]);
});
