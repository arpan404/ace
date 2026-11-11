import { describe, expect, test } from "vitest";
import type {
  ForgeRepository,
  ProjectRepositoryConfig,
  SourceControlPreferences,
} from "@ace/protocol";
import {
  normalizeRepositoryConfig,
  repositoryWriteRefusal,
  resolveProjectRepositories,
} from "./project-repositories.ts";

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "app" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "app" };
const upstream: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "upstream",
  name: "app",
};
const enterprise: ForgeRepository = {
  forge: "github",
  host: "git.corp.example",
  owner: "team",
  name: "app",
};
/** A provider ace has no adapter for. */
const unreadable: ForgeRepository = {
  forge: "gitbucket",
  host: "gitbucket.corp.example",
  owner: "acme",
  name: "app",
};
const origin = { name: "origin", fetchUrls: ["git@github.com:acme/app.git"] };
const mirror = { name: "mirror", fetchUrls: ["https://gitlab.com/acme/app.git"] };
const upstreamRemote = { name: "upstream", fetchUrls: ["https://github.com/upstream/app"] };
const preferences: SourceControlPreferences = {
  hosts: [
    { host: "github.com" },
    { host: "gitlab.com" },
    { host: "gitbucket.corp.example", forge: "gitbucket" },
  ],
  host: "github.com",
  remote: "origin",
};
const config = (value: Partial<ProjectRepositoryConfig>): ProjectRepositoryConfig => ({
  added: [],
  hidden: [],
  primary: null,
  ...value,
});

describe("a project's repositories", () => {
  const cases: {
    name: string;
    remotes: { name: string; fetchUrls: string[] }[];
    preferences?: SourceControlPreferences;
    config?: ProjectRepositoryConfig;
    aliases?: Record<string, string>;
    listed: { repository: ForgeRepository; source: string; remote?: string }[];
    primary: ForgeRepository | undefined;
  }[] = [
    {
      name: "a project with no choices keeps the global remote name's repository as its primary",
      remotes: [mirror, origin],
      preferences,
      listed: [
        { repository: github, source: "remote", remote: "origin" },
        { repository: gitlab, source: "remote", remote: "mirror" },
      ],
      primary: github,
    },
    {
      name: "with no preferences and no origin the first remote is the primary, as before",
      remotes: [mirror, upstreamRemote],
      listed: [
        { repository: gitlab, source: "remote", remote: "mirror" },
        { repository: upstream, source: "remote", remote: "upstream" },
      ],
      primary: gitlab,
    },
    {
      name: "with preferences and no remote of the global name there is no primary until one is chosen",
      remotes: [mirror],
      preferences,
      listed: [{ repository: gitlab, source: "remote", remote: "mirror" }],
      primary: undefined,
    },
    {
      name: "a remote on a host nobody configured is not listed",
      remotes: [origin, { name: "corp", fetchUrls: ["https://git.corp.example/team/app.git"] }],
      preferences,
      listed: [{ repository: github, source: "remote", remote: "origin" }],
      primary: github,
    },
    {
      name: "two remotes naming one repository are one entry, under the global remote name",
      remotes: [{ name: "alt", fetchUrls: ["https://github.com/ACME/app.git"] }, origin],
      preferences,
      listed: [{ repository: github, source: "remote", remote: "origin" }],
      primary: github,
    },
    {
      name: "an SSH alias resolves to its real host",
      remotes: [{ name: "origin", fetchUrls: ["work:acme/app.git"] }],
      preferences,
      aliases: { work: "github.com" },
      listed: [{ repository: github, source: "remote", remote: "origin" }],
      primary: github,
    },
    {
      name: "a chosen primary on another remote wins",
      remotes: [origin, upstreamRemote],
      preferences,
      config: config({ primary: upstream }),
      listed: [
        { repository: github, source: "remote", remote: "origin" },
        { repository: upstream, source: "remote", remote: "upstream" },
      ],
      primary: upstream,
    },
    {
      name: "hiding the default primary moves it to the first visible repository",
      remotes: [origin, mirror],
      preferences,
      config: config({ hidden: [github] }),
      listed: [
        { repository: github, source: "remote", remote: "origin" },
        { repository: gitlab, source: "remote", remote: "mirror" },
      ],
      primary: gitlab,
    },
    {
      name: "a manual repository is listed after remotes and can be the primary",
      remotes: [origin],
      preferences,
      config: config({ added: [gitlab], primary: gitlab }),
      listed: [
        { repository: github, source: "remote", remote: "origin" },
        { repository: gitlab, source: "manual" },
      ],
      primary: gitlab,
    },
    {
      name: "a manual repository a remote also names is that remote's one entry",
      remotes: [origin],
      preferences,
      config: config({ added: [{ ...github, owner: "Acme" }] }),
      listed: [{ repository: github, source: "remote", remote: "origin" }],
      primary: github,
    },
  ];
  test.each(cases)("$name", (entry) => {
    const resolved = resolveProjectRepositories({
      remotes: entry.remotes,
      preferences: entry.preferences,
      aliases: entry.aliases ?? {},
      config: entry.config,
    });
    expect(
      resolved.repositories.map(({ repository, source, remote }) => ({
        repository,
        source,
        ...(remote ? { remote } : {}),
      })),
    ).toEqual(entry.listed);
    expect(resolved.primary?.repository).toEqual(entry.primary);
    expect(resolved.repositories.filter((item) => item.primary).length).toBe(entry.primary ? 1 : 0);
  });

  test("a manual repository on a host removed from settings stays listed as unavailable", () => {
    const resolved = resolveProjectRepositories({
      remotes: [origin],
      preferences,
      config: config({ added: [enterprise], primary: enterprise }),
    });
    expect(resolved.repositories[1]).toMatchObject({
      repository: enterprise,
      available: false,
      unavailable: "host_not_configured",
    });
    // An unavailable primary never stands; today's rule takes over.
    expect(resolved.primary?.repository).toEqual(github);
  });

  test("a manual repository whose host now has another provider is unavailable", () => {
    const resolved = resolveProjectRepositories({
      remotes: [],
      preferences,
      config: config({ added: [{ ...gitlab, forge: "github" }] }),
    });
    expect(resolved.repositories[0]).toMatchObject({
      available: false,
      unavailable: "provider_mismatch",
    });
    expect(resolved.primary).toBeUndefined();
  });

  test("a provider ace can't read is listed but unavailable, and keeps today's primary", () => {
    const resolved = resolveProjectRepositories({
      remotes: [{ name: "origin", fetchUrls: ["git@gitbucket.corp.example:acme/app.git"] }],
      preferences,
      config: undefined,
    });
    expect(resolved.repositories).toEqual([
      expect.objectContaining({ repository: unreadable, unavailable: "provider_unsupported" }),
    ]);
    expect(resolved.primary?.repository).toEqual(unreadable);
  });

  test("a chosen primary whose remote went away is shown as missing, never dropped", () => {
    const resolved = resolveProjectRepositories({
      remotes: [origin],
      preferences,
      config: config({ primary: upstream }),
    });
    expect(resolved.repositories[1]).toMatchObject({
      repository: upstream,
      available: false,
      unavailable: "remote_missing",
      primary: false,
    });
    expect(resolved.primary?.repository).toEqual(github);
  });
});

describe("writes", () => {
  const resolved = resolveProjectRepositories({
    remotes: [origin, mirror],
    preferences,
    config: config({ hidden: [gitlab], added: [enterprise] }),
  });
  test.each([
    { name: "a visible repository is writable", repository: github, refusal: undefined },
    { name: "a hidden one is refused", repository: gitlab, refusal: "repository_hidden" },
    {
      name: "an unavailable one is refused",
      repository: enterprise,
      refusal: "repository_unavailable",
    },
    { name: "one the project doesn't list is not its to refuse", repository: upstream },
  ])("$name", ({ repository, refusal }) => {
    expect(repositoryWriteRefusal(resolved, repository)).toBe(refusal);
  });
});

describe("saved choices", () => {
  test("a primary that is also hidden is refused", () => {
    expect(normalizeRepositoryConfig(config({ primary: github, hidden: [github] }))).toEqual({
      ok: false,
      error: "primary_hidden",
    });
  });
  test("empty choices save as none, so the project behaves as one that never chose", () => {
    expect(normalizeRepositoryConfig(config({}))).toEqual({ ok: true, config: undefined });
    expect(normalizeRepositoryConfig(null)).toEqual({ ok: true, config: undefined });
  });
  test("each repository is saved once whatever its case", () => {
    expect(
      normalizeRepositoryConfig(config({ added: [gitlab, { ...gitlab, owner: "ACME" }] })),
    ).toEqual({ ok: true, config: config({ added: [gitlab] }) });
  });
});

test("hidden and unavailable repository entries still declare their adapter capabilities", () => {
  const result = resolveProjectRepositories({
    remotes: [origin, mirror],
    preferences,
    config: config({ hidden: [gitlab], added: [unreadable] }),
  });
  expect(result.repositories).toMatchObject([
    { repository: github, capabilities: expect.arrayContaining(["reviews.merge", "issues.write"]) },
    {
      repository: gitlab,
      visible: false,
      capabilities: expect.arrayContaining(["reviews.read", "reviews.files"]),
    },
    { repository: unreadable, available: false, capabilities: [] },
  ]);
});
