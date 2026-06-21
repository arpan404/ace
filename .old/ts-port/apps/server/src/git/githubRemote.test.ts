import { describe, expect, it } from "vitest";

import {
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  selectPreferredGitHubCloneUrl,
  shouldPreferSshRemote,
} from "./githubRemote.ts";

describe("githubRemote", () => {
  it.each([
    ["git@github.com:octocat/hello-world.git", "octocat/hello-world"],
    ["ssh://git@github.com/octocat/hello-world.git", "octocat/hello-world"],
    ["ssh://git@github.com:443/octocat/hello-world.git", "octocat/hello-world"],
    ["git@ssh.github.com:443/octocat/hello-world.git", "octocat/hello-world"],
    ["https://github.com/octocat/hello-world.git", "octocat/hello-world"],
    ["git://github.com/octocat/hello-world", "octocat/hello-world"],
  ])("parses GitHub repository identity from %s", (remoteUrl, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl)).toBe(expected);
  });

  it("ignores non-GitHub remotes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@example.com:octocat/repo.git"),
    ).toBe(null);
  });

  it("detects SSH remotes and selects SSH clone URLs", () => {
    expect(shouldPreferSshRemote("git@github.com:octocat/repo.git")).toBe(true);
    expect(
      selectPreferredGitHubCloneUrl({
        currentRemoteUrl: "ssh://git@github.com/octocat/repo.git",
        cloneUrls: {
          url: "https://github.com/octocat/repo",
          sshUrl: "git@github.com:octocat/repo.git",
        },
      }),
    ).toBe("git@github.com:octocat/repo.git");
  });

  it("keeps HTTPS clone URLs when the current remote is HTTPS", () => {
    expect(
      selectPreferredGitHubCloneUrl({
        currentRemoteUrl: "https://github.com/octocat/repo.git",
        cloneUrls: {
          url: "https://github.com/octocat/repo",
          sshUrl: "git@github.com:octocat/repo.git",
        },
      }),
    ).toBe("https://github.com/octocat/repo");
  });
});
