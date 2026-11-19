import { expect, test } from "vitest";
import { isReadOnlyApiRequest, isAdmittedWriteRequest } from "./read-only-api.ts";

const read = ["api", "repos/team/app/pulls", "--method", "GET", "--login", "work", "--include"];
const write = [
  "api",
  "repos/team/app/issues/7/comments",
  "--method",
  "POST",
  "--login",
  "work",
  "--include",
  "--data",
  "@-",
];
const writes = [{ method: "POST" as const, endpoint: /^repos\/team\/app\/issues\/\d+\/comments$/ }];
test("tea admits only an explicit GET on the selected login", () => {
  expect(isReadOnlyApiRequest("tea", { command: "tea", args: read }, "work")).toBe(true);
  for (const args of [
    read.slice(0, -1),
    [...read, "--method", "POST"],
    [...read, "--header", "Authorization: secret"],
    [...read, "--login", "other"],
    [...read, "-f", "a=b"],
    [...read, "--output", "file"],
    [...read.slice(0, 3), "POST", ...read.slice(4)],
  ])
    expect(isReadOnlyApiRequest("tea", { command: "tea", args }, "work")).toBe(false);
  expect(isReadOnlyApiRequest("tea", { command: "tea", args: read, input: "{}" }, "work")).toBe(
    false,
  );
});
test.each([
  "https://evil.test/repos/a/b",
  "/api/v1/repos/a/b",
  "//evil.test",
  "repos/a/../user",
  "repos/a/%2e%2e/user",
  "repos/a/%252e%252e/user",
  "repos/{owner}/{repo}",
  "repos/a/b#x",
  "repos/a/b\\x",
])("tea refuses a substituted or redirected endpoint %s", (endpoint) => {
  expect(
    isReadOnlyApiRequest(
      "tea",
      { command: "tea", args: ["api", endpoint, ...read.slice(2)] },
      "work",
    ),
  ).toBe(false);
});
test("tea writes require the declared method and whole endpoint with a JSON object on stdin", () => {
  expect(
    isAdmittedWriteRequest(
      "tea",
      { command: "tea", args: write, input: '{"body":"hello"}' },
      "work",
      writes,
    ),
  ).toBe(true);
  for (const input of [undefined, "[]", "null", "false", "{bad"])
    expect(
      isAdmittedWriteRequest(
        "tea",
        { command: "tea", args: write, ...(input === undefined ? {} : { input }) },
        "work",
        writes,
      ),
    ).toBe(false);
  for (const args of [
    [...write, "-H", "X-HTTP-Method-Override: DELETE"],
    [...write.slice(0, -1), "@file"],
    ["api", "repos/team/app/issues/7/comments?x=1", ...write.slice(2)],
    [...write.slice(0, 5), "other", ...write.slice(6)],
  ])
    expect(
      isAdmittedWriteRequest("tea", { command: "tea", args, input: "{}" }, "work", writes),
    ).toBe(false);
});
