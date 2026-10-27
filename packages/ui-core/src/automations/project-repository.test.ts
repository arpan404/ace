import { expect, test } from "vitest";
import { projectRepository } from "./project-repository.ts";

const remotes = (...list: [name: string, url: string][]) => ({
  git: { remotes: list.map(([name, url]) => ({ name, fetchUrls: [url] })) },
});

test("a GitHub trigger starts from the project's origin, over upstream and the rest", () => {
  expect(
    projectRepository(
      remotes(
        ["upstream", "https://github.com/acme/ace.git"],
        ["origin", "git@github.com:arpan404/ace.git"],
      ),
    ),
  ).toBe("arpan404/ace");
  expect(projectRepository(remotes(["upstream", "https://github.com/acme/ace"]))).toBe("acme/ace");
});

test("remotes that aren't on GitHub are skipped, and none leaves the field to the person", () => {
  expect(
    projectRepository(
      remotes(["origin", "/srv/git/ace.git"], ["mirror", "https://gitlab.com/acme/ace.git"]),
    ),
  ).toBeUndefined();
  expect(projectRepository({ git: null })).toBeUndefined();
  expect(projectRepository(undefined)).toBeUndefined();
});
