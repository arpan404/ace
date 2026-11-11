import { expect, test } from "vitest";
import { ForgeRepository } from "@ace/protocol";
import { repositoryFromParam, repositoryParam } from "./pull-request-route.ts";

test.each([
  { forge: "github", host: "git.example.com", owner: "team", name: "repo" },
  { forge: "origin", host: "origin.cursor.com", owner: "team", name: "repo" },
  { forge: "gitlab", host: "git.example.com", owner: "team/subgroup", name: "repo" },
])("a page address preserves $forge identity when reopened", (input) => {
  const repository = ForgeRepository.parse(input);
  expect(repositoryFromParam(repositoryParam(repository))).toEqual(repository);
});
test("existing GitHub and public Origin links open on the right host", () => {
  expect(
    repositoryParam({ forge: "github", host: "github.com", owner: "team", name: "repo" }),
  ).toBe("github.com/team/repo");
  expect(repositoryFromParam("origin.cursor.com/team/repo")?.forge).toBe("origin");
  expect(repositoryFromParam("github.com/team/repo")?.forge).toBe("github");
  expect(repositoryFromParam("nonsense@github.com/team/repo")).toBeUndefined();
});
