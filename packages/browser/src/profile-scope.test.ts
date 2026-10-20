import { join } from "node:path";
import { expect, test } from "vitest";
import { scopedProfileDir } from "./profile-scope.ts";

const root = join("/data", "browser");
const a = { threadId: "thread-a", workspaceId: "project-1" };
const b = { threadId: "thread-b", workspaceId: "project-1" };
const c = { threadId: "thread-c", workspaceId: "project-2" };

test("the global scope opens every thread of every project in one shared profile", () => {
  const dirs = [a, b, c].map((ids) => scopedProfileDir(root, "global", ids));
  expect(new Set(dirs).size).toBe(1);
  expect(dirs[0]).toBe(join(root, "profile"));
});

test("the project scope shares a profile within a project and never across projects", () => {
  expect(scopedProfileDir(root, "project", a)).toBe(scopedProfileDir(root, "project", b));
  expect(scopedProfileDir(root, "project", a)).not.toBe(scopedProfileDir(root, "project", c));
  expect(scopedProfileDir(root, "project", a)).not.toBe(scopedProfileDir(root, "global", a));
});

test("the thread scope gives each thread its own profile, apart from its project's", () => {
  expect(scopedProfileDir(root, "thread", a)).not.toBe(scopedProfileDir(root, "thread", b));
  expect(scopedProfileDir(root, "thread", a)).not.toBe(scopedProfileDir(root, "project", a));
});

test("ids that look like paths still name a profile inside ace's profiles folder", () => {
  const hostile = { threadId: "../../etc", workspaceId: "/Users/me/.ssh" };
  for (const scope of ["project", "thread"] as const) {
    const dir = scopedProfileDir(root, scope, hostile);
    expect(dir.startsWith(join(root, "profiles") + "/")).toBe(true);
    expect(dir.slice(join(root, "profiles").length + 1)).toMatch(/^(project|thread)-[a-f0-9]{32}$/);
  }
});
