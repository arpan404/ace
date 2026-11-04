import { expect, test } from "vitest";
import { prUrl } from "./pr-reference.ts";

test("existing GitHub and GitLab review links retain their provider URL", () => {
  expect(
    prUrl({
      repository: { forge: "github", host: "github.com", owner: "team", name: "repo" },
      number: 7,
    }),
  ).toBe("https://github.com/team/repo/pull/7");
  expect(
    prUrl({
      repository: { forge: "gitlab", host: "gitlab.com", owner: "team/subgroup", name: "repo" },
      number: 7,
    }),
  ).toBe("https://gitlab.com/team/subgroup/repo/-/merge_requests/7");
});

test.each(["gitbucket", "bitbucket", "gitea", "forgejo"] as const)(
  "%s is never rendered as a GitLab review link",
  (forge) => {
    expect(() =>
      prUrl({
        repository: { forge, host: "git.example.com", owner: "team", name: "repo" },
        number: 7,
      }),
    ).toThrow("unsupported");
  },
);
