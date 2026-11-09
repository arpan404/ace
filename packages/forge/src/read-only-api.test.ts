import { expect, test } from "vitest";
import { isReadOnlyApiRequest, type ReadOnlyCli } from "./read-only-api.ts";

const host = "gitlab.example.com";
const glabRead = (endpoint: string) => ["api", endpoint, "-X", "GET", "--hostname", host];

const cases: [string, ReadOnlyCli, string, string[], boolean][] = [
  ["glab GET read", "glab", "glab", [...glabRead("projects/1/merge_requests"), "--include"], true],
  ["glab GET read without output flags", "glab", "glab", glabRead("projects/1"), true],
  [
    "glab paginated GET read",
    "glab",
    "glab",
    [...glabRead("projects/1/merge_requests"), "--include", "--paginate"],
    true,
  ],
  ["origin GET read", "origin", "origin", ["api", "/repos/o/r/pulls", "--method", "GET"], true],
  ["glab without a method", "glab", "glab", ["api", "projects/1", "--hostname", host], false],
  ["glab without a hostname", "glab", "glab", ["api", "projects/1", "-X", "GET"], false],
  [
    "glab with another hostname",
    "glab",
    "glab",
    ["api", "projects/1", "-X", "GET", "--hostname", "evil.example.com"],
    false,
  ],
  [
    "glab with a second hostname",
    "glab",
    "glab",
    [...glabRead("projects/1"), "--hostname", "evil.example.com"],
    false,
  ],
  ["glab POST", "glab", "glab", ["api", "projects/1", "-X", "POST", "--hostname", host], false],
  ["origin PATCH", "origin", "origin", ["api", "/repos/o/r/pulls/1", "--method", "PATCH"], false],
  ["a second method overriding GET", "glab", "glab", [...glabRead("p/1"), "-X", "DELETE"], false],
  ["a joined method", "origin", "origin", ["api", "/repos/o/r", "--method=GET"], false],
  ["a joined short method", "glab", "glab", [...glabRead("projects/1"), "-XPOST"], false],
  ["a flag cluster with a method", "glab", "glab", [...glabRead("projects/1"), "-iXPOST"], false],
  ["a flag cluster with a field", "glab", "glab", [...glabRead("projects/1"), "-iFtitle=x"], false],
  ["a raw field", "glab", "glab", [...glabRead("projects/1"), "-f", "title=x"], false],
  ["a typed field", "glab", "glab", [...glabRead("projects/1"), "-Ftitle=x"], false],
  ["a header", "glab", "glab", [...glabRead("projects/1"), "-H", "X-Http-Method: POST"], false],
  [
    "a long header",
    "origin",
    "origin",
    ["api", "/repos/o/r", "--method", "GET", "--header", "X-Http-Method-Override: DELETE"],
    false,
  ],
  [
    "a long field",
    "origin",
    "origin",
    ["api", "/repos/o/r", "--method", "GET", "--field", "a=b"],
    false,
  ],
  ["an input file", "glab", "glab", [...glabRead("projects/1"), "--input", "body.json"], false],
  ["verbose output", "glab", "glab", [...glabRead("projects/1"), "--verbose"], false],
  ["a repeated output flag", "glab", "glab", [...glabRead("p/1"), "--include", "--include"], false],
  ["an extra positional", "glab", "glab", [...glabRead("projects/1"), "projects/2"], false],
  [
    "an extra origin positional",
    "origin",
    "origin",
    ["api", "/repos/o/r", "--method", "GET", "/repos/o/other"],
    false,
  ],
  ["another subcommand", "glab", "glab", ["mr", "merge", "1", "-X", "GET"], false],
  ["a flag where the endpoint goes", "origin", "origin", ["api", "--method", "GET"], false],
  ["the other provider's CLI", "glab", "origin", ["api", "/repos/o/r", "--method", "GET"], false],
  ["gh through a GitLab runner", "glab", "gh", glabRead("user"), false],
];

test.each(cases)("%s", (_name, cli, command, args, allowed) => {
  expect(isReadOnlyApiRequest(cli, { command, args }, host)).toBe(allowed);
});

test("a request carrying a body on stdin is refused even as a GET", () => {
  expect(
    isReadOnlyApiRequest(
      "glab",
      { command: "glab", args: glabRead("projects/1"), input: "{}" },
      host,
    ),
  ).toBe(false);
});
