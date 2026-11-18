import { join } from "node:path";
import { expect, it } from "vitest";
import { registered, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";
import { cloneOn, commandOn, identityOn, legacyOn, send } from "./transfer-identity-support.ts";

it("a new landing takes the sender's logical project", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const sent = identityOn(m.source, workspaceId);
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed" });
  expect(done.result?.identityConflict).toBeUndefined();
  expect(identityOn(m.target, done.result?.workspaceId ?? "")).toMatchObject({
    id: sent?.id,
    source: "transfer",
  });
});

it("a reused registration without an identity takes the sender's", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = legacyOn(m.target, await cloneOn(m, origin, "app-there"));
  const workspaceId = await m.addProject(m.source, path);
  const done = await send(m, workspaceId);
  expect(done.result?.workspaceId).toBe(there);
  expect(identityOn(m.target, there)).toMatchObject({
    id: identityOn(m.source, workspaceId)?.id,
    source: "transfer",
  });
});

it("a reused registration in another logical project keeps it and reports the conflict", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await m.addProject(m.target, await cloneOn(m, origin, "app-there"));
  const kept = identityOn(m.target, there);
  const workspaceId = await m.addProject(m.source, path);
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({
    phase: "completed",
    result: { workspaceId: there, identityConflict: { identityId: kept?.id } },
  });
  expect(identityOn(m.target, there)).toEqual(kept);
});

it("a registration of the same logical project with another origin is never the remote landing", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const other = await repositoryWithOrigin(m.targetRoot, "fork");
  const workspaceId = await m.addProject(m.source, path);
  const id = identityOn(m.source, workspaceId)?.id ?? "";
  // Linked by the person, but a checkout of another repository.
  const linked = await m.addProject(m.target, other.path);
  await commandOn(m.target, {
    type: "workspace.identity.link",
    workspaceId: linked,
    identityId: id,
  });
  const sameOrigin = legacyOn(m.target, await cloneOn(m, origin, "app-there"));
  const done = await send(m, workspaceId);
  // The existing rule chose: the checkout with the same origin.
  expect(done.result?.workspaceId).toBe(sameOrigin);
  // No new copy was made beside them.
  expect(registered(m.target).filter((each) => each.startsWith(m.targetRoot))).toEqual([
    join(m.targetRoot, "app-there"),
    join(m.targetRoot, "fork"),
  ]);
});

it("a linked registration with the sender's origin is where the work lands", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const id = identityOn(m.source, workspaceId)?.id ?? "";
  // Two checkouts of the origin there; the person linked the second.
  await m.addProject(m.target, await cloneOn(m, origin, "app-a"));
  const linked = await m.addProject(m.target, await cloneOn(m, origin, "app-b"));
  await commandOn(m.target, {
    type: "workspace.identity.link",
    workspaceId: linked,
    identityId: id,
  });
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed", result: { workspaceId: linked } });
  expect(done.result?.identityConflict).toBeUndefined();
});
