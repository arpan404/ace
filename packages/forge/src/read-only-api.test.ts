import { expect, test } from "vitest";
import {
  isAdmittedApiRequest,
  isAdmittedWriteRequest,
  isReadOnlyApiRequest,
  type HostApiCli,
} from "./read-only-api.ts";

const host = "gitlab.example.com";
const glabRead = (endpoint: string) => ["api", endpoint, "-X", "GET", "--hostname", host];

const cases: [string, HostApiCli, string, string[], boolean][] = [
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

const noteWrite = { method: "POST" as const, endpoint: /^projects\/[^/]+\/issues\/\d+\/notes$/ };
const write = (args: string[], input?: string) => ({ command: "glab", args, input });
const noteArgs = (endpoint: string, method = "POST", host = "gitlab.com") => [
  "api",
  endpoint,
  "-X",
  method,
  "--hostname",
  host,
  "--include",
  "--input",
  "-",
];

test.each([
  ["an admitted note", noteArgs("projects/1/issues/2/notes"), '{"body":"hi"}', true],
  ["another endpoint", noteArgs("projects/1/issues/2"), '{"body":"hi"}', false],
  ["another method", noteArgs("projects/1/issues/2/notes", "DELETE"), '{"body":"hi"}', false],
  ["another host", noteArgs("projects/1/issues/2/notes", "POST", "evil.com"), "{}", false],
  ["no body", noteArgs("projects/1/issues/2/notes"), undefined, false],
  ["a body that isn't an object", noteArgs("projects/1/issues/2/notes"), "[1]", false],
  ["a field flag", [...noteArgs("projects/1/issues/2/notes"), "-f", "body=x"], "{}", false],
] as const)("glab write: %s", (_name, args, input, allowed) => {
  expect(isAdmittedWriteRequest("glab", write([...args], input), "gitlab.com", [noteWrite])).toBe(
    allowed,
  );
});

test("reads stay admitted and no write is admitted without a listed write", () => {
  const read = write(["api", "projects/1", "-X", "GET", "--hostname", "gitlab.com"]);
  expect(isAdmittedApiRequest("glab", read, "gitlab.com", [])).toBe(true);
  const note = write(noteArgs("projects/1/issues/2/notes"), "{}");
  expect(isAdmittedApiRequest("glab", note, "gitlab.com", [])).toBe(false);
});

test("Origin admits no writes yet", () => {
  const post = { command: "origin", args: ["api", "/repos/o/r/pulls/1", "--method", "POST"] };
  expect(isAdmittedApiRequest("origin", post, "origin.cursor.com", [noteWrite])).toBe(false);
});
