import { describe, expect, it } from "vitest";
import { sameRepositoryConfig } from "@ace/forge/project-repositories";
import {
  WorkspaceId,
  type ForgeRepository,
  type ProjectRepositories,
  type ProjectRepositoryConfig,
} from "@ace/protocol";
import {
  addRepository,
  hideRepository,
  makePrimary,
  removeRepository,
  repositoryLabel,
  reviewRepositories,
  saveRepositoryEdit,
  showRepository,
} from "./project-repositories.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };
const corp: ForgeRepository = { forge: "gitlab", host: "git.corp", owner: "team/sub", name: "api" };

const project = (config: ProjectRepositories["config"]): ProjectRepositories => ({
  workspaceId: WorkspaceId.parse("w1"),
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

/** A daemon's saved choices, refusing a save whose `expected` isn't them any more. */
const saved = (start: ProjectRepositoryConfig | null) => {
  let current = start;
  let saves = 0;
  return {
    get current() {
      return current;
    },
    get saves() {
      return saves;
    },
    read: async () => current,
    save: async (
      next: ProjectRepositoryConfig | null,
      expected: ProjectRepositoryConfig | null,
    ) => {
      saves++;
      if (!sameRepositoryConfig(current, expected)) return "repositories_changed";
      current = next;
      return "saved";
    },
    changed: (outcome: string) => outcome === "repositories_changed",
  };
};

describe("saving one repository edit", () => {
  it("re-applies the edit to choices another device saved meanwhile, keeping both", async () => {
    // The phone read no choices; the web has since hidden GitHub.
    const daemon = saved({ added: [], hidden: [github], primary: null });
    const outcome = await saveRepositoryEdit(daemon, (config) => addRepository(config, corp), null);
    expect(outcome).toBe("saved");
    expect(daemon.current).toEqual({ added: [corp], hidden: [github], primary: null });
  });

  it("re-reads once, and a second conflict is the answer", async () => {
    const daemon = saved(null);
    const racing = {
      ...daemon,
      // Another device saves again between every read and save.
      read: async () => {
        const seen = await daemon.read();
        await daemon.save(addRepository(seen, { ...github, name: `x${daemon.saves}` }), seen);
        return seen;
      },
    };
    const outcome = await saveRepositoryEdit(racing, (config) => hideRepository(config, gitlab), {
      added: [],
      hidden: [],
      primary: github,
    });
    expect(outcome).toBe("repositories_changed");
    expect(daemon.current?.hidden).toEqual([]);
  });
});
