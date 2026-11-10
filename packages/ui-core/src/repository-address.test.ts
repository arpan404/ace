import { describe, expect, it } from "vitest";
import { parseRepositoryAddress, repositoryAddressProblem } from "./repository-address.ts";

const hosts = [{ host: "github.com" }, { host: "git.corp.example", forge: "gitlab" as const }];

describe("a repository address typed into a project's settings", () => {
  it.each([
    [
      "https://github.com/acme/ace.git",
      { forge: "github", host: "github.com", owner: "acme", name: "ace" },
    ],
    [
      "git@gitlab.com:acme/ace.git",
      { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" },
    ],
    [
      "ssh://git@git.corp.example/team/sub/api.git",
      { forge: "gitlab", host: "git.corp.example", owner: "team/sub", name: "api" },
    ],
  ])("%s names its repository on a known host", (address, repository) => {
    expect(parseRepositoryAddress(address, hosts)).toEqual({ kind: "repository", repository });
  });

  it("names a host missing from Source control settings and says where to add it", () => {
    const parsed = parseRepositoryAddress("https://git.other.example/acme/ace", hosts);
    expect(parsed).toEqual({ kind: "host_not_configured", host: "git.other.example" });
    expect(repositoryAddressProblem(parsed)).toMatch(
      /git\.other\.example.*Source control settings/,
    );
  });

  it("refuses a provider ace reads no pull requests from", () => {
    const parsed = parseRepositoryAddress("https://bitbucket.org/acme/ace.git", hosts);
    expect(parsed).toEqual({ kind: "provider_unsupported", forge: "bitbucket" });
    expect(repositoryAddressProblem(parsed)).toMatch(/Bitbucket/);
  });

  it("calls text that isn't an address invalid and an empty field nothing", () => {
    expect(parseRepositoryAddress("acme ace", hosts).kind).toBe("invalid");
    expect(parseRepositoryAddress("https://github.com/acme", hosts).kind).toBe("invalid");
    expect(parseRepositoryAddress("   ", hosts)).toEqual({ kind: "empty" });
  });
});
