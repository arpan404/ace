import { describe, expect, it } from "vitest";
import type { ForgeRepository, ProjectRepositories } from "@ace/protocol";
import {
  addRepository,
  hideRepository,
  makePrimary,
  pushRemote,
  removeRepository,
  repositoryLabel,
  reviewRepositories,
  showRepository,
} from "./project-repositories.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };
const corp: ForgeRepository = { forge: "gitlab", host: "git.corp", owner: "team/sub", name: "api" };

const project = (config: ProjectRepositories["config"]): ProjectRepositories => ({
  workspaceId: "w1",
  primary: gitlab,
  config,
  repositories: [
    {
      repository: github,
      source: "remote",
      remote: "origin",
      visible: true,
      primary: false,
      available: true,
    },
    {
      repository: gitlab,
      source: "remote",
      remote: "mirror",
      visible: true,
      primary: true,
      available: true,
    },
    {
      repository: corp,
      source: "manual",
      visible: true,
      primary: false,
      available: false,
      unavailable: "host_not_configured",
    },
    {
      repository: { ...github, name: "old" },
      source: "remote",
      remote: "old",
      visible: false,
      primary: false,
      available: true,
    },
  ],
});

describe("project repositories", () => {
  it("list reviews only from visible, available repositories", () => {
    expect(reviewRepositories(project(null))).toEqual([github, gitlab]);
    expect(reviewRepositories(undefined)).toEqual([]);
  });

  it("push to the primary's remote once the project has choices", () => {
    expect(pushRemote(project({ added: [], hidden: [], primary: gitlab }), "origin")).toBe(
      "mirror",
    );
    expect(pushRemote(project(null), "origin")).toBe("origin");
  });

  it("name the host only when it isn't the provider's public one", () => {
    expect(repositoryLabel(gitlab)).toBe("GitLab · acme/ace");
    expect(repositoryLabel(corp)).toBe("GitLab · git.corp/team/sub/api");
  });

  it("hiding the primary clears the primary choice", () => {
    expect(
      hideRepository({ added: [], hidden: [], primary: gitlab }, { ...gitlab, owner: "ACME" }),
    ).toEqual({
      added: [],
      hidden: [{ ...gitlab, owner: "ACME" }],
      primary: null,
    });
  });

  it("making a hidden repository primary shows it again", () => {
    expect(makePrimary({ added: [], hidden: [github], primary: null }, github)).toEqual({
      added: [],
      hidden: [],
      primary: github,
    });
  });

  it("undoing every choice returns to no choices", () => {
    expect(showRepository(hideRepository(null, github), github)).toBeNull();
    expect(removeRepository(addRepository(null, corp), corp)).toBeNull();
  });

  it("adding a repository twice keeps one, and removing it drops every choice about it", () => {
    const added = addRepository(addRepository(null, corp), { ...corp, host: "GIT.CORP" });
    expect(added?.added).toEqual([corp]);
    expect(removeRepository(makePrimary(added, corp), corp)).toBeNull();
  });
});
