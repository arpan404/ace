import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git, transferMachines } from "./transfer-test-support.ts";
import { commandOn, identityOn, send } from "./transfer-identity-support.ts";

it("a registration linked through a copied marker never receives a transfer, or its ignored files", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "a.txt"), "a\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "one");
  const workspaceId = await m.addProject(m.source, path);
  const id = identityOn(m.source, workspaceId)?.id ?? "";
  // There, an unrelated repository whose copied marker named the same project, confirmed.
  const unrelated = join(m.targetRoot, "unrelated");
  await mkdir(unrelated);
  await git(unrelated, "init", "-b", "main");
  const marked = await m.addProject(m.target, unrelated);
  await commandOn(m.target, {
    type: "workspace.identity.link",
    workspaceId: marked,
    identityId: id,
    viaMarker: true,
  });
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed", method: "bundle" });
  expect(done.result?.workspaceId).not.toBe(marked);
  // Nothing landed in it.
  expect((await readdir(unrelated)).filter((name) => !name.startsWith(".ace-git"))).toEqual([
    ".git",
  ]);
});
