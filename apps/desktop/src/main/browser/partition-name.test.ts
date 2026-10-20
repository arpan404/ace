import { expect, test } from "vitest";
import { persistentPartitionName, projectPartitionName } from "./partition-name.ts";

const a = { threadId: "thread-a", workspaceId: "project-1" };
const b = { threadId: "thread-b", workspaceId: "project-1" };
const c = { threadId: "thread-c", workspaceId: "project-2" };

test("the global scope opens every thread of every project in one partition", () => {
  const names = [a, b, c].map((ids) => persistentPartitionName("global", ids));
  expect(new Set(names).size).toBe(1);
});

test("the project scope shares a partition within a project and never across projects", () => {
  expect(persistentPartitionName("project", a)).toBe(persistentPartitionName("project", b));
  expect(persistentPartitionName("project", a)).not.toBe(persistentPartitionName("project", c));
  // A removed project's purge finds the partition its threads used.
  expect(persistentPartitionName("project", a)).toBe(projectPartitionName("project-1"));
});

test("the thread scope gives each thread its own partition", () => {
  expect(persistentPartitionName("thread", a)).not.toBe(persistentPartitionName("thread", b));
  expect(persistentPartitionName("thread", a)).not.toBe(persistentPartitionName("project", a));
});

test("an older daemon that names no scope keeps each thread in the partition it had", () => {
  expect(persistentPartitionName(undefined, a)).toBe(persistentPartitionName("thread", a));
});

test("ids that look like paths still name a plain partition", () => {
  const hostile = { threadId: "../../etc", workspaceId: "/Users/me/.ssh" };
  for (const scope of ["global", "project", "thread"] as const)
    expect(persistentPartitionName(scope, hostile)).toMatch(/^ace-browser-[a-z0-9-]+$/);
});
