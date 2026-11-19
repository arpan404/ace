import { expect, test } from "vitest";
import { isAdmittedWriteRequest, isReadOnlyApiRequest } from "./read-only-api.ts";
import { bitbucketReviewWrites } from "./bitbucket-reviews.ts";

const repository = { owner: "team", name: "app" };
const writes = bitbucketReviewWrites(repository, 7);
const read = (endpoint: string, ...rest: string[]) => ({
  command: "bkt",
  args: ["api", endpoint, "--method", "GET", "--context", "work", ...rest],
});
const write = (method: string, endpoint: string, body?: string) => ({
  command: "bkt",
  args: [
    "api",
    endpoint,
    "--method",
    method,
    "--context",
    "work",
    ...(body === undefined ? [] : ["--input", body]),
  ],
});

test.each([
  "/2.0/user",
  "/2.0/repositories/team/app",
  "/2.0/repositories/team/app/pullrequests/7",
  "/2.0/repositories/team/app/pullrequests?state=OPEN&state=MERGED&sort=-updated_on&pagelen=25&page=2",
  "/2.0/repositories/team/app/pullrequests/7/commits?page=a1b2c3",
  "/2.0/repositories/fork-owner/app/commit/abcdef123456",
])("bkt admits an explicit GET of %s on the pinned context", (endpoint) => {
  expect(isReadOnlyApiRequest("bkt", read(endpoint), "work")).toBe(true);
});

test("bkt refuses a read with any other flag, context, method or a body", () => {
  const endpoint = "/2.0/repositories/team/app";
  for (const request of [
    read(endpoint, "--header", "Authorization: x"),
    read(endpoint, "--param", "q=x"),
    read(endpoint, "--jq", ".values"),
    { command: "bkt", args: ["api", endpoint, "--method", "GET", "--context", "other"] },
    { command: "bkt", args: ["api", endpoint, "--method", "GET"] },
    { command: "bkt", args: ["api", endpoint, "-X", "GET", "--context", "work"] },
    { command: "bkt", args: ["api", endpoint, "--method", "POST", "--context", "work"] },
    { ...read(endpoint), input: "{}" },
    { ...read(endpoint), command: "glab" },
  ])
    expect(isReadOnlyApiRequest("bkt", request, "work")).toBe(false);
});

test.each([
  "https://evil.test/2.0/user",
  "https://api.bitbucket.org/2.0/user",
  "//evil.test/2.0/user",
  "/rest/api/1.0/projects",
  "/2.0/workspaces/team",
  "/2.0/user/permissions/repositories",
  "2.0/repositories/team/app",
  "/2.0/repositories/team/../../user",
  "/2.0/repositories/team/app/./pullrequests",
  "/2.0/repositories/team/app//pullrequests",
  "/2.0/repositories/team/%2e%2e/user",
  "/2.0/repositories/team/app#x",
  '/2.0/repositories/team/app?q=title ~ "x"',
  "/2.0/repositories/team/app?a=1?b=2",
  "-X",
])("bkt refuses a substituted or redirected endpoint %s", (endpoint) => {
  expect(isReadOnlyApiRequest("bkt", read(endpoint), "work")).toBe(false);
});

test.each([
  ["POST", `/2.0/repositories/team/app/pullrequests/7/comments`, '{"content":{"raw":"hi"}}'],
  ["POST", `/2.0/repositories/team/app/pullrequests/7/approve`, undefined],
  ["DELETE", `/2.0/repositories/team/app/pullrequests/7/approve`, undefined],
  ["POST", `/2.0/repositories/team/app/pullrequests/7/request-changes`, undefined],
  ["DELETE", `/2.0/repositories/team/app/pullrequests/7/request-changes`, undefined],
])("bkt admits exactly the review write %s %s", (method, endpoint, body) => {
  expect(isAdmittedWriteRequest("bkt", write(method, endpoint, body), "work", writes)).toBe(true);
});

test("bkt admits no other review write: other PR, repository, method, endpoint, context or body", () => {
  const comments = "/2.0/repositories/team/app/pullrequests/7/comments";
  for (const request of [
    write("POST", "/2.0/repositories/team/app/pullrequests/8/comments", "{}"),
    write("POST", "/2.0/repositories/other/app/pullrequests/7/comments", "{}"),
    write("POST", "/2.0/repositories/team/app/pullrequests/7/merge", "{}"),
    write("POST", "/2.0/repositories/team/app/pullrequests/7/decline", "{}"),
    write("PUT", comments, "{}"),
    write("DELETE", "/2.0/repositories/team/app/pullrequests/7/comments/3"),
    write("POST", `${comments}?x=1`, "{}"),
    write("POST", comments, "[1]"),
    write("POST", comments, "not json"),
    { ...write("POST", comments, "{}"), input: "{}" },
    { ...write("POST", comments), input: "{}" },
    { command: "bkt", args: [...write("POST", comments, "{}").args, "--header", "X: y"] },
    {
      command: "bkt",
      args: ["api", comments, "--method", "POST", "--context", "work", "--field", "a=b"],
    },
    {
      command: "bkt",
      args: ["api", comments, "--method", "POST", "--context", "other", "--input", "{}"],
    },
  ])
    expect(isAdmittedWriteRequest("bkt", request, "work", writes)).toBe(false);
});

test("bkt writes are never admitted as reads, and reads never as writes", () => {
  const comments = "/2.0/repositories/team/app/pullrequests/7/comments";
  expect(isReadOnlyApiRequest("bkt", write("POST", comments, "{}"), "work")).toBe(false);
  expect(isAdmittedWriteRequest("bkt", read(comments), "work", writes)).toBe(false);
});
