import { describe, expect, it } from "vitest";
import { repositoryFromRemote } from "./detect.ts";

describe("forge remote recognition", () => {
  it.each([
    ["git@github.com:owner/repo.git", "github", "github.com", "owner"],
    ["ssh://git@ssh.github.com:443/owner/repo.git", "github", "github.com", "owner"],
    ["https://gitlab.com/group/subgroup/repo.git", "gitlab", "gitlab.com", "group/subgroup"],
    ["git@bitbucket.org:owner/repo.git", "bitbucket", "bitbucket.org", "owner"],
    ["https://codeberg.org/owner/repo.git", "forgejo", "codeberg.org", "owner"],
  ])("recognizes %s without changing its identity", (remote, forge, host, owner) => {
    expect(repositoryFromRemote(remote)).toEqual({ forge, host, owner, name: "repo" });
  });

  it.each(["gitbucket", "gitea", "forgejo", "gitlab", "bitbucket"] as const)(
    "requires an explicit mapping for self-hosted %s",
    (forge) => {
      const remote = "git@work:owner/repo.git";
      expect(() => repositoryFromRemote(remote)).toThrow();
      expect(
        repositoryFromRemote(remote, { "git.example": forge }, { work: "git.example" }),
      ).toEqual({ forge, host: "git.example", owner: "owner", name: "repo" });
    },
  );

  it.each(["github", "gitbucket", "bitbucket", "gitea", "forgejo"] as const)(
    "rejects nested repository owners for %s",
    (forge) => {
      expect(() =>
        repositoryFromRemote("git@git.example:a/b/repo.git", { "git.example": forge }),
      ).toThrow();
    },
  );

  it("does not let custom mappings override known public hosts", () => {
    expect(
      repositoryFromRemote("git@github.com:owner/repo.git", { "github.com": "gitbucket" }).forge,
    ).toBe("github");
    expect(() => repositoryFromRemote("git@gitbucket.example:owner/repo.git")).toThrow();
  });
});

it.each([
  "https://origin.cursor.com/team/repo.git",
  "git@origin.cursor.com:team/repo.git",
  "https://origin.cursor.com/git/team/repo.git",
])("recognizes Cursor Origin remote %s", (remote) => {
  expect(repositoryFromRemote(remote)).toEqual({
    forge: "origin",
    host: "origin.cursor.com",
    owner: "team",
    name: "repo",
  });
});
