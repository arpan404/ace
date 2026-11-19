import { ThreadListEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import { groupProjects, type GroupableProject } from "@ace/ui-core/project-groups";
import { archivedInScope, filterRows, scopeOf, threadCounts } from "./project-scope.ts";

const ace = { remoteKey: { remotes: ["github.com/arpan/ace"], subpath: "" } };
const project = (id: string, name: string, extra: Partial<GroupableProject> = {}) => ({
  id,
  name,
  path: `/code/${name}`,
  ...extra,
});

// The owner's three machines: ace on each, notes only on the Mac, a fork of ace on omarchy.
const groups = groupProjects([
  {
    machineId: "mac",
    machineName: "Mac",
    online: true,
    here: true,
    projects: [project("a1", "ace", ace), project("n1", "notes")],
  },
  { machineId: "rijan", machineName: "Rijan", online: true, projects: [project("a2", "ace", ace)] },
  {
    machineId: "omarchy",
    machineName: "omarchy",
    online: true,
    projects: [
      project("a3", "ace", ace),
      project("f3", "ace-fork", {
        remoteKey: { remotes: ["github.com/someone/ace"], subpath: "" },
      }),
    ],
  },
]);

const counts = new Map([
  ["mac/a1", 3],
  ["rijan/a2", 2],
  ["omarchy/a3", 5],
  ["omarchy/f3", 1],
  ["mac/gone", 4],
]);
const rowsFor = (device: readonly string[] | undefined, chosen: string | null = null) =>
  filterRows({
    groups,
    device,
    own: "mac",
    counts,
    chosen,
    name: (id) => (id === "gone" ? "Old project" : id),
    isChat: () => false,
  }).map((row) => [row.label, row.value, row.threads, row.actsOn]);

test.each([
  {
    behaviour: "every machine: one row per logical project, counts summed across machines",
    device: undefined,
    rows: [
      ["ace", "a1", 10, "a1"],
      ["ace-fork · omarchy", "omarchy/f3", 1, undefined],
      ["notes", "n1", 0, "n1"],
      ["Old project", "gone", 4, undefined],
    ],
  },
  {
    behaviour: "this Mac and omarchy: projects from both, counts from those two only",
    device: ["mac", "omarchy"],
    rows: [
      ["ace", "a1", 8, "a1"],
      ["ace-fork · omarchy", "omarchy/f3", 1, undefined],
      ["notes", "n1", 0, "n1"],
      ["Old project", "gone", 4, undefined],
    ],
  },
  {
    behaviour: "another machine alone: only its projects, choosing ace still keeps this Mac's id",
    device: ["rijan"],
    rows: [["ace", "a1", 2, "a1"]],
  },
])("$behaviour", ({ device, rows }) => {
  expect(rowsFor(device)).toEqual(rows);
});

test("choosing a project covers its checkouts on every machine, and a fork stays out", () => {
  const scope = scopeOf("a1", groups, "mac");
  expect([...(scope.checkouts ?? [])].toSorted()).toEqual(["mac/a1", "omarchy/a3", "rijan/a2"]);
  expect(scope.here).toEqual(["a1"]);
  expect(scope.window).toBe("a1");
});

test("a project with no checkout here narrows nothing on this daemon", () => {
  const scope = scopeOf("omarchy/f3", groups, "mac");
  expect([...(scope.checkouts ?? [])]).toEqual(["omarchy/f3"]);
  expect(scope.here).toEqual([]);
  expect(scope.window).toBeUndefined();
});

test("a project only threads mention, or no choice, filters as before", () => {
  expect([...(scopeOf("gone", groups, "mac").checkouts ?? [])]).toEqual(["mac/gone"]);
  expect(scopeOf(null, groups, "mac").checkouts).toBeUndefined();
});

test("a stored choice of another machine's checkout selects the group's row", () => {
  const row = rowsFor(undefined, "rijan/a2").find(([label]) => label === "ace");
  expect(row?.[1]).toBe("rijan/a2");
});

const thread = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) =>
  ThreadListEntry.parse({
    id,
    workspaceId,
    title: id,
    provider: "codex",
    createdAt: 0,
    updatedAt: 0,
    status: { state: "done" },
    ...extra,
  });

test("the archive shows both of this machine's checkouts of the chosen project", () => {
  // ace and a worktree of it registered beside it, both on this Mac.
  const twoHere = groupProjects([
    {
      machineId: "mac",
      machineName: "Mac",
      online: true,
      here: true,
      projects: [
        project("a1", "ace", ace),
        project("a9", "ace-review", ace),
        project("n1", "notes"),
      ],
    },
  ]);
  const archived = [
    thread("t1", "a1", { archivedAt: 10 }),
    thread("t2", "a9", { archivedAt: 20 }),
    thread("t3", "n1", { archivedAt: 30 }),
  ];
  expect(archivedInScope(archived, scopeOf("a1", twoHere, "mac").checkouts, "mac")).toEqual([
    "t2",
    "t1",
  ]);
  expect(archivedInScope(archived, scopeOf(null, twoHere, "mac").checkouts, "mac")).toEqual([
    "t3",
    "t2",
    "t1",
  ]);
  // A project with no checkout here has nothing in this machine's archive.
  expect(archivedInScope(archived, scopeOf("omarchy/f3", groups, "mac").checkouts, "mac")).toEqual(
    [],
  );
});

const hostOf = (entry: ThreadListEntry) => entry.id.split(":")[0];

test("counts add each machine's threads to its checkout, leaving out chats, drafts and removed ones", () => {
  const others = [
    thread("rijan:1", "a2"),
    thread("rijan:2", "a2"),
    thread("omarchy:1", "a3"),
    thread("omarchy:2", "a3", { deletedAt: 5 }),
    thread("omarchy:3", "a3", {
      details: { workspace: { id: "a3", name: "Chat", path: "/chats/a3", kind: "chat" } },
    }),
  ];
  const counted = threadCounts([{ id: "a1", threads: 3 }], others, "mac", hostOf);
  expect(Object.fromEntries(counted)).toEqual({ "mac/a1": 3, "rijan/a2": 2, "omarchy/a3": 1 });
});
