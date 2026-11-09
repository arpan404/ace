import { expect, test } from "vitest";
import { isReadOnlyApiRequest, type ReadOnlyCli } from "./read-only-api.ts";

const cases: [string, ReadOnlyCli, string, string[], boolean][] = [
  [
    "glab GET read",
    "glab",
    "glab",
    ["api", "projects/1/merge_requests", "-X", "GET", "--hostname", "gitlab.com", "--include"],
    true,
  ],
  ["origin GET read", "origin", "origin", ["api", "/repos/o/r/pulls", "--method", "GET"], true],
  [
    "glab without a method",
    "glab",
    "glab",
    ["api", "projects/1", "--hostname", "gitlab.com"],
    false,
  ],
  ["glab POST", "glab", "glab", ["api", "projects/1/merge_requests", "-X", "POST"], false],
  ["origin PATCH", "origin", "origin", ["api", "/repos/o/r/pulls/1", "--method", "PATCH"], false],
  [
    "a second method overriding GET",
    "glab",
    "glab",
    ["api", "projects/1", "-X", "GET", "-X", "DELETE"],
    false,
  ],
  ["a joined method", "origin", "origin", ["api", "/repos/o/r", "--method=GET"], false],
  ["a joined short method", "glab", "glab", ["api", "projects/1", "-XPOST"], false],
  ["a raw field", "glab", "glab", ["api", "projects/1", "-X", "GET", "-f", "title=x"], false],
  ["a typed field", "glab", "glab", ["api", "projects/1", "-X", "GET", "-Ftitle=x"], false],
  [
    "a long field",
    "origin",
    "origin",
    ["api", "/repos/o/r", "--method", "GET", "--field", "a=b"],
    false,
  ],
  [
    "a raw long field",
    "origin",
    "origin",
    ["api", "/repos/o/r", "--method", "GET", "--raw-field=a=b"],
    false,
  ],
  [
    "an input file",
    "glab",
    "glab",
    ["api", "projects/1", "-X", "GET", "--input", "body.json"],
    false,
  ],
  ["verbose output", "glab", "glab", ["api", "projects/1", "-X", "GET", "--verbose"], false],
  ["another subcommand", "glab", "glab", ["mr", "merge", "1", "-X", "GET"], false],
  ["a flag where the endpoint goes", "origin", "origin", ["api", "--method", "GET"], false],
  ["the other provider's CLI", "glab", "origin", ["api", "/repos/o/r", "--method", "GET"], false],
  ["gh through a GitLab runner", "glab", "gh", ["api", "user", "-X", "GET"], false],
];

test.each(cases)("%s", (_name, cli, command, args, allowed) => {
  expect(isReadOnlyApiRequest(cli, { command, args })).toBe(allowed);
});

test("a request carrying a body on stdin is refused even as a GET", () => {
  expect(
    isReadOnlyApiRequest("glab", {
      command: "glab",
      args: ["api", "projects/1", "-X", "GET"],
      input: "{}",
    }),
  ).toBe(false);
});
