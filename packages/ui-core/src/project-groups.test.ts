import { expect, test } from "vitest";
import {
  defaultCheckout,
  groupOf,
  groupProjects,
  type GroupableProject,
  type MachineProjectList,
} from "./project-groups.ts";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

const project = (
  id: string,
  name: string,
  identity?: string,
  extra: Partial<GroupableProject> & { aliases?: string[] } = {},
): GroupableProject => {
  const { aliases = [], ...rest } = extra;
  return {
    id,
    name,
    path: `/code/${name}`,
    ...(identity ? { identity: { id: identity, aliases } } : {}),
    ...rest,
  };
};

const machine = (
  machineId: string,
  projects: GroupableProject[],
  options: Partial<MachineProjectList> = {},
): MachineProjectList => ({
  machineId,
  machineName: machineId,
  online: true,
  projects,
  ...options,
});

const keysOf = (lists: MachineProjectList[]) =>
  groupProjects(lists).map((group) => group.checkouts.map((each) => each.key).toSorted());

test("registrations without an identity, or from an older daemon, are each a project of their own", () => {
  expect(
    keysOf([machine("laptop", [project("a", "app")]), machine("server", [project("a", "app")])]),
  ).toEqual([["laptop/a"], ["server/a"]]);
});

test("the same identity on two machines is one project with a checkout on each", () => {
  const [group, ...rest] = groupProjects([
    machine("laptop", [project("a", "app", P)], { here: true }),
    machine("server", [project("b", "app", P)]),
  ]);
  expect(rest).toEqual([]);
  expect(group?.checkouts.map((each) => [each.machineName, each.path])).toEqual([
    ["laptop", "/code/app"],
    ["server", "/code/app"],
  ]);
});

test("a machine offline during a merge still joins the group through the alias", () => {
  expect(
    keysOf([
      machine("a", [project("p", "app", P, { aliases: [Q] })]),
      machine("b", [project("q", "app", P, { aliases: [Q] })]),
      // Offline when Q merged into P: it still reports Q.
      machine("c", [project("q2", "app", Q)], { online: false }),
    ]),
  ).toEqual([["a/p", "b/q", "c/q2"]]);
});

test("chains across machines join, and the group only through its direct edge past the alias cap", () => {
  // A merged Q into P; B merged P into R; C still reports Q.
  expect(
    keysOf([
      machine("a", [project("1", "app", P, { aliases: [Q] })]),
      machine("b", [project("2", "app", R, { aliases: [P] })]),
      machine("c", [project("3", "app", Q)]),
    ]),
  ).toEqual([["a/1", "b/2", "c/3"]]);
  // A registration whose 32 reported aliases leave out an old one still joins through any
  // other machine that reports that edge directly.
  const many = Array.from(
    { length: 32 },
    (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
  );
  expect(
    keysOf([
      machine("a", [project("1", "app", P, { aliases: many })]),
      machine("b", [project("2", "app", P, { aliases: [Q] })]),
      machine("c", [project("3", "app", Q)]),
    ]),
  ).toEqual([["a/1", "b/2", "c/3"]]);
});

test("unlinking one registration splits off only that one", () => {
  const before = [
    machine("a", [project("1", "app", P)]),
    machine("b", [project("2", "app", P), project("3", "app-copy", P)]),
  ];
  expect(keysOf(before)).toEqual([["a/1", "b/2", "b/3"]]);
  const after = [
    machine("a", [project("1", "app", P)]),
    machine("b", [project("2", "app", P), project("3", "app-copy", R)]),
  ];
  expect(keysOf(after)).toEqual([["a/1", "b/2"], ["b/3"]]);
});

test("the label is this machine's name for it, else the most recently used, and other names show", () => {
  const lists = [
    machine("laptop", [project("1", "ace", P, { openedAt: 10 })], { here: true }),
    machine("server", [project("2", "ace-server", P, { openedAt: 50 })]),
  ];
  expect(groupProjects(lists)[0]).toMatchObject({ label: "ace", otherNames: ["ace-server"] });
  const elsewhere = lists.map((list): MachineProjectList =>
    Object.assign({}, list, { here: false }),
  );
  expect(groupProjects(elsewhere)[0]).toMatchObject({ label: "ace-server", otherNames: ["ace"] });
});

test("renaming one machine's checkout leaves the other's name, and the label follows the rule", () => {
  const lists = [
    machine("laptop", [project("1", "renamed", P)], { here: true }),
    machine("server", [project("2", "ace", P)]),
  ];
  const [group] = groupProjects(lists);
  expect(group?.checkouts.map((each) => each.name)).toEqual(["renamed", "ace"]);
  expect(group?.label).toBe("renamed");
});

test("two checkouts on one machine both stay, and the default is the one used last", () => {
  const [group] = groupProjects([
    machine("laptop", [
      project("1", "app", P, { openedAt: 5 }),
      project("2", "app-worktree", P, { openedAt: 9 }),
    ]),
  ]);
  expect(group?.checkouts.map((each) => each.workspaceId)).toEqual(["2", "1"]);
  expect(defaultCheckout(group!, "laptop")?.workspaceId).toBe("2");
});

test("a project only on an offline machine is listed, offline, with no default", () => {
  const [group] = groupProjects([
    machine("laptop", [], { here: true }),
    machine("server", [project("1", "app", P, { openedAt: 99 })], { online: false }),
  ]);
  expect(group).toMatchObject({ label: "app", offline: true });
  expect(defaultCheckout(group!)).toBeUndefined();
  expect(defaultCheckout(group!, "server")).toBeUndefined();
});

test("an offline checkout is never the default, however recent", () => {
  const [group] = groupProjects([
    machine("laptop", [project("1", "app", P, { openedAt: 1 })], { here: true }),
    machine("server", [project("2", "app", P, { openedAt: 99 })], { online: false }),
  ]);
  expect(defaultCheckout(group!)?.key).toBe("laptop/1");
  expect(group?.checkouts.map((each) => each.key)).toEqual(["laptop/1", "server/2"]);
});

test("chats are never projects, and a registration is found by machine and id", () => {
  const groups = groupProjects([
    machine("laptop", [
      project("chat", "Chat", undefined, { kind: "chat" }),
      project("1", "app", P),
    ]),
  ]);
  expect(groups.map((group) => group.label)).toEqual(["app"]);
  expect(groupOf(groups, "laptop", "1")?.label).toBe("app");
  expect(groupOf(groups, "laptop", "chat")).toBeUndefined();
});
