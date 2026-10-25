import { expect, test } from "vitest";
import { landingBranchName, machineSlug, normalizeRemoteUrl } from "./index.ts";

test("every spelling of one hosted repository normalises to the same key", () => {
  const spellings = [
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo",
    "https://github.com/Owner/Repo/",
    "https://user@GitHub.COM:443/Owner/Repo.git/",
    "http://github.com/Owner/Repo",
    "git@github.com:Owner/Repo.git",
    "github.com:Owner/Repo",
    "ssh://git@github.com/Owner/Repo.git",
    "ssh://git@GITHUB.com:22/Owner/Repo",
    "git://github.com/Owner/Repo.git",
  ];
  expect(new Set(spellings.map((url) => normalizeRemoteUrl(url)))).toEqual(
    new Set(["github.com/Owner/Repo"]),
  );
});

test("path case, other owners and other hosts stay different repositories", () => {
  const keys = [
    "git@github.com:owner/repo.git",
    "git@github.com:Owner/Repo.git",
    "git@github.com:other/repo.git",
    "git@gitlab.com:owner/repo.git",
    "https://github.com/owner/group/repo.git",
  ].map((url) => normalizeRemoteUrl(url));
  expect(new Set(keys).size).toBe(keys.length);
});

test("local paths and file URLs normalise to the resolved path", () => {
  expect(normalizeRemoteUrl("/srv/repos/app.git/")).toBe("/srv/repos/app.git");
  expect(normalizeRemoteUrl("file:///srv/repos/app.git")).toBe("/srv/repos/app.git");
  expect(normalizeRemoteUrl("../app", "/home/me/work/checkout")).toBe("/home/me/work/app");
  expect(normalizeRemoteUrl("./app", "/home/me")).toBe("/home/me/app");
  expect(normalizeRemoteUrl("/srv/a")).not.toBe(normalizeRemoteUrl("/srv/b"));
});

test("file URLs decode their path, keep a drive letter and keep another host apart", () => {
  expect(normalizeRemoteUrl("file:///srv/my%20repos/app.git/")).toBe("/srv/my repos/app.git");
  expect(normalizeRemoteUrl("file://localhost/srv/repos/app")).toBe("/srv/repos/app");
  expect(normalizeRemoteUrl("file:///srv/repos/../app")).toBe("/srv/app");
  expect(normalizeRemoteUrl("file:///C:/repos/app/")).toBe("C:/repos/app");
  expect(normalizeRemoteUrl("file://nas/repos/app")).not.toBe(normalizeRemoteUrl("/repos/app"));
});

test("an ssh remote with a path from the root keeps that path", () => {
  expect(normalizeRemoteUrl("git@host.example:/srv/git/app.git")).toBe("host.example/srv/git/app");
  expect(normalizeRemoteUrl("ssh://git@host.example/srv/git/app.git")).toBe(
    "host.example/srv/git/app",
  );
});

const heads = (entries: Record<string, string>) => new Map(Object.entries(entries));

test("a transferred branch keeps its name when free or already at the commit", () => {
  expect(
    landingBranchName({ branch: "feature", commit: "b", machine: "Studio", heads: heads({}) }),
  ).toEqual({ branch: "feature", existing: false });
  expect(
    landingBranchName({
      branch: "feature",
      commit: "b",
      machine: "Studio",
      heads: heads({ feature: "b" }),
    }),
  ).toEqual({ branch: "feature", existing: true });
});

const land = (entries: Record<string, string>) =>
  landingBranchName({
    branch: "feature",
    commit: "b",
    machine: "Arpan’s MacBook Pro",
    heads: heads(entries),
  });

test("a branch name the target uses for other commits lands with a -from-machine suffix", () => {
  expect(land({ feature: "a" })).toEqual({
    branch: "feature-from-arpans-macbook-pro",
    existing: false,
  });
  expect(land({ feature: "a", "feature-from-arpans-macbook-pro": "c" })).toEqual({
    branch: "feature-from-arpans-macbook-pro-2",
    existing: false,
  });
  expect(
    land({
      feature: "a",
      "feature-from-arpans-macbook-pro": "c",
      "feature-from-arpans-macbook-pro-2": "b",
    }),
  ).toEqual({ branch: "feature-from-arpans-macbook-pro-2", existing: true });
});

test("a name that would nest under or over an existing branch is skipped", () => {
  expect(
    landingBranchName({
      branch: "feature",
      commit: "b",
      machine: "Studio",
      heads: heads({ "feature/x": "a" }),
    }),
  ).toEqual({ branch: "feature-from-studio", existing: false });
});

test("machine names become branch-safe fragments", () => {
  expect(machineSlug("Arpan’s MacBook Pro")).toBe("arpans-macbook-pro");
  expect(machineSlug("  Studio (2) ")).toBe("studio-2");
  expect(machineSlug("雪")).toBe("machine");
});

test("a branch whose folder is a branch there lands flattened instead of hanging", () => {
  expect(
    landingBranchName({
      branch: "feature/login",
      commit: "b",
      machine: "Studio",
      heads: heads({ feature: "a" }),
    }),
  ).toEqual({ branch: "feature-login-from-studio", existing: false });
});

test("landing gives up with ref_conflict once every candidate name is taken", () => {
  const taken: Record<string, string> = { "feature-login": "x", feature: "a" };
  for (let n = 1; n <= 100; n++) taken[`feature-login-from-studio${n === 1 ? "" : `-${n}`}`] = "x";
  expect(() =>
    landingBranchName({
      branch: "feature/login",
      commit: "b",
      machine: "Studio",
      heads: heads(taken),
    }),
  ).toThrow(expect.objectContaining({ code: "ref_conflict" }));
});

test("a branch at the commit but checked out in a worktree is passed over for a suffixed one", () => {
  expect(
    landingBranchName({
      branch: "main",
      commit: "b",
      machine: "Studio",
      heads: heads({ main: "b" }),
      occupied: new Set(["main"]),
    }),
  ).toEqual({ branch: "main-from-studio", existing: false });
});
