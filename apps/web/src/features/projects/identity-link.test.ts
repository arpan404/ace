import { groupProjects, type MachineProjectList } from "@ace/ui-core/project-groups";
import { expect, test } from "vitest";
import { linkPlan } from "./identity-link.ts";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const N = "99999999-9999-4999-8999-999999999999";

const list = (
  machineId: string,
  projects: { id: string; identity?: string; aliases?: string[] }[],
): MachineProjectList => ({
  machineId,
  machineName: machineId,
  online: true,
  projects: projects.map((each) => ({
    id: each.id,
    name: "app",
    path: `/code/${each.id}`,
    ...(each.identity ? { identity: { id: each.identity, aliases: each.aliases ?? [] } } : {}),
  })),
});

const a = { machineId: "laptop", workspaceId: "a" };
const b = { machineId: "server", workspaceId: "b" };
const newId = () => N;

test("two checkouts without identities both link to one new logical project", () => {
  const groups = groupProjects([list("laptop", [{ id: "a" }]), list("server", [{ id: "b" }])]);
  expect(linkPlan(groups, a, b, ["laptop", "server"], newId)).toEqual({
    identityId: N,
    steps: [
      {
        machineId: "laptop",
        payload: { type: "workspace.identity.link", workspaceId: "a", identityId: N },
      },
      {
        machineId: "server",
        payload: { type: "workspace.identity.link", workspaceId: "b", identityId: N },
      },
    ],
  });
});

test("a checkout without one joins the other's logical project, and nothing else moves", () => {
  const groups = groupProjects([
    list("laptop", [{ id: "a", identity: P }]),
    list("server", [{ id: "b" }]),
  ]);
  expect(linkPlan(groups, a, b, ["laptop", "server"], newId)).toEqual({
    identityId: P,
    steps: [
      {
        machineId: "server",
        payload: { type: "workspace.identity.link", workspaceId: "b", identityId: P },
      },
    ],
  });
});

test("two logical projects merge: every id of the other group, on every machine that keeps them", () => {
  const groups = groupProjects([
    list("laptop", [{ id: "a", identity: P }]),
    list("server", [{ id: "b", identity: Q, aliases: [R] }]),
    list("studio", [{ id: "c", identity: R }]),
  ]);
  const plan = linkPlan(groups, a, b, ["laptop", "server", "studio"], newId);
  expect(plan.identityId).toBe(P);
  expect(plan.steps).toHaveLength(6);
  for (const machineId of ["laptop", "server", "studio"])
    for (const from of [Q, R])
      expect(plan.steps).toContainEqual({
        machineId,
        payload: { type: "workspace.identity.merge", from, into: P },
      });
});

test("checkouts already in one logical project need nothing sent", () => {
  const groups = groupProjects([
    list("laptop", [{ id: "a", identity: P }]),
    list("server", [{ id: "b", identity: Q, aliases: [P] }]),
  ]);
  expect(linkPlan(groups, a, b, ["laptop", "server"], newId)).toEqual({ identityId: P, steps: [] });
});
