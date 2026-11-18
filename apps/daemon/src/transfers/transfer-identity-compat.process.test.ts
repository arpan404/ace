import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";
import {
  commandOn,
  identityOn,
  olderSender,
  olderTarget,
  send,
} from "./transfer-identity-support.ts";

it("a target from before identity still takes the transfer, and is never sent one", async () => {
  const calls: Record<string, unknown>[] = [];
  const m = await transferMachines({ transport: olderTarget(calls) });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed" });
  const commits = calls.filter((call) => call.op === "commit");
  expect(commits.length).toBeGreaterThan(0);
  for (const commit of commits) expect(commit).not.toHaveProperty("identity");
});

it("a sender from before identity lands as it always did, the copy its own project", async () => {
  const m = await transferMachines({ transport: olderSender });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed" });
  const landed = identityOn(m.target, done.result?.workspaceId ?? "");
  expect(landed?.source).toBe("created");
  expect(landed?.id).not.toBe(identityOn(m.source, workspaceId)?.id);
});

it("a repository without a remote lands in the registration linked to it, if that is a repository", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "a.txt"), "a\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "one");
  const workspaceId = await m.addProject(m.source, path);
  const id = identityOn(m.source, workspaceId)?.id ?? "";
  // There: a plain folder and a repository, both linked to it; only the repository fits.
  const plain = join(m.targetRoot, "local-notes");
  await mkdir(plain);
  const folder = await m.addProject(m.target, plain);
  const repo = join(m.targetRoot, "local-copy");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  const repository = await m.addProject(m.target, repo);
  for (const linked of [folder, repository])
    await commandOn(m.target, {
      type: "workspace.identity.link",
      workspaceId: linked,
      identityId: id,
    });
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({
    phase: "completed",
    method: "bundle",
    result: { workspaceId: repository },
  });
  expect(await git(repo, "log", "--format=%s", "main")).toBe("one");
});

it("a linked folder inside another repository is never where a bundle lands", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "a.txt"), "a\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "one");
  const workspaceId = await m.addProject(m.source, path);
  const id = identityOn(m.source, workspaceId)?.id ?? "";
  // There: a monorepo whose `tools` folder was linked to it.
  const mono = join(m.targetRoot, "mono");
  await mkdir(join(mono, "tools"), { recursive: true });
  await git(mono, "init", "-b", "main");
  const tools = await m.addProject(m.target, join(mono, "tools"));
  await commandOn(m.target, {
    type: "workspace.identity.link",
    workspaceId: tools,
    identityId: id,
  });
  const done = await send(m, workspaceId);
  expect(done).toMatchObject({ phase: "completed", method: "bundle" });
  expect(done.result?.workspaceId).not.toBe(tools);
  // The monorepo got no branch from it.
  expect(await git(mono, "branch", "--list")).toBe("");
});
