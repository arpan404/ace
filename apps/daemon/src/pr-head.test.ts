import { describe, expect, test } from "vitest";
import { resolveProjectRepositories, type ForgeRepositoryMetadata } from "@ace/forge";
import type { ForgeRepository, ProjectRepositoryConfig } from "@ace/protocol";
import { prHeadMetadata, resolvePrHead } from "./pr-head.ts";

const repo = (owner: string, host = "github.com", forge: "github" | "gitlab" = "github") =>
  ({ forge, host, owner, name: "ace" }) satisfies ForgeRepository;
const fork = repo("fork");
const octo = repo("octo");
const mirror = repo("octo", "gitlab.com", "gitlab");
const remotes = [
  { name: "origin", fetchUrls: ["https://github.com/fork/ace.git"] },
  { name: "upstream", fetchUrls: ["https://github.com/octo/ace.git"] },
  { name: "mirror", fetchUrls: ["https://gitlab.com/octo/ace.git"] },
];
const forks: Record<string, ForgeRepository> = { fork: octo };

/** The host's answer: `fork/ace` forks `octo/ace`; the rest fork nothing. */
const metadata = async (entry: {
  repository: ForgeRepository;
}): Promise<ForgeRepositoryMetadata> => {
  const parent = forks[entry.repository.owner];
  return {
    repository: entry.repository,
    defaultBranch: "main",
    parent:
      parent && entry.repository.forge === "github"
        ? { repository: parent, defaultBranch: "trunk" }
        : null,
  };
};

const resolve = (config: ProjectRepositoryConfig | undefined) =>
  resolveProjectRepositories({ remotes, preferences: undefined, config });
const head = async (config: ProjectRepositoryConfig | undefined) => {
  const resolved = resolve(config);
  const value = await resolvePrHead({ resolved, globalRemote: "origin", metadata });
  return {
    remote: value.remote,
    pushed: value.pushed.repository,
    opensOn:
      (await prHeadMetadata(value, resolved, metadata)).parent?.repository ??
      value.pushed.repository,
  };
};
const choose = (choice: Partial<ProjectRepositoryConfig>): ProjectRepositoryConfig => ({
  added: [],
  hidden: [],
  primary: null,
  ...choice,
});

describe("where a new pull request's branch is pushed", () => {
  test("with no saved choices, to the global remote, opening on its fork parent as before", async () => {
    expect(await head(undefined)).toEqual({ remote: "origin", pushed: fork, opensOn: octo });
  });

  test("with the fork's parent primary, to the fork, opening on the primary", async () => {
    expect(await head(choose({ primary: octo }))).toEqual({
      remote: "origin",
      pushed: fork,
      opensOn: octo,
    });
  });

  test("with a primary the global remote doesn't fork, to the primary's own remote", async () => {
    expect(await head(choose({ primary: mirror }))).toEqual({
      remote: "mirror",
      pushed: mirror,
      opensOn: mirror,
    });
  });

  test("with the fork's parent hidden, the pull request stays in the fork", async () => {
    expect(await head(choose({ hidden: [octo] }))).toEqual({
      remote: "origin",
      pushed: fork,
      opensOn: fork,
    });
  });

  test("with the global remote's repository hidden, to the primary's remote", async () => {
    expect(await head(choose({ hidden: [fork], primary: octo }))).toEqual({
      remote: "upstream",
      pushed: octo,
      opensOn: octo,
    });
  });

  test("a hand-added primary that only the fork names is reached through the fork", async () => {
    const lone = remotes.slice(0, 1);
    const resolved = resolveProjectRepositories({
      remotes: lone,
      preferences: undefined,
      config: choose({ added: [octo], primary: octo }),
    });
    const value = await resolvePrHead({ resolved, globalRemote: "origin", metadata });
    expect([value.remote, value.pushed.repository]).toEqual(["origin", fork]);
  });
});
