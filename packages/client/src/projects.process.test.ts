import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Project, type WorkspaceChanged } from "@ace/protocol";
import { setup, ready } from "./test-support.ts";

test("client projects and long-thread requests coexist while updating another client live", async () => {
  const root = await mkdtemp(join(homedir(), ".ace-client-projects-"));
  const f = await setup(undefined, undefined, undefined, { home: root, roots: async () => [root] });
  try {
    const { client, scheduler } = f.make();
    const { client: other } = f.make();
    await ready(client);
    await ready(other);
    const changes: WorkspaceChanged[] = [];
    const stop = other.projects.onChanged((change) => changes.push(change));
    const path = join(root, "opened-folder");
    await mkdir(path);
    const parsed = new URL(`ace://open?folder=${encodeURIComponent(path)}`);
    const receipt = await client.projects.add(
      { path: parsed.searchParams.get("folder") ?? "" },
      {},
      "deep-link",
    );
    const project = Project.parse(receipt.workspace);
    expect(receipt).toMatchObject({ ok: true, workspace: { path } });
    expect(await client.projects.add({ path })).toMatchObject({
      ok: true,
      workspace: { id: project.id },
    });
    expect(
      await client.projects.rename({ workspaceId: project.id, name: "Opened project" }),
    ).toMatchObject({ ok: true, workspace: { name: "Opened project" } });
    expect(await client.projects.inspect(path)).toMatchObject({
      result: { kind: "inspection", path, git: null },
    });
    expect(await client.projects.browse({ path: root, limit: 1 })).toMatchObject({
      result: { kind: "directories", entries: [{ name: "opened-folder" }] },
    });
    expect(await client.projects.home()).toMatchObject({ result: { kind: "home", path: root } });
    expect(await client.projects.recentFolders()).toMatchObject({
      result: { kind: "recentFolders", folders: [{ id: project.id }] },
    });
    expect(await client.turnsPage({ threadId: f.thread.id })).toMatchObject({
      threadId: f.thread.id,
      turns: [],
    });
    const head = f.daemon.store.headSeq();
    const mark = client.markThreadRead({ threadId: f.thread.id, lastSeenSeq: head });
    scheduler.advance(100);
    expect(await mark).toMatchObject({ ok: true });
    expect(await client.threadReadState({ threadId: f.thread.id })).toMatchObject({
      lastSeenSeq: head,
    });
    expect(await client.projects.remove({ workspaceId: project.id })).toMatchObject({ ok: true });
    await other.projects.recentFolders();
    expect(changes.map((change) => change.change)).toEqual(["added", "renamed", "removed"]);
    const listed = await client.request({
      type: "workspace.request",
      operation: { op: "workspaces.list" },
    });
    if (listed.result.kind !== "workspaces") throw new Error("Expected project list");
    expect(listed.result.workspaces.map((workspace) => workspace.id)).not.toContain(project.id);
    stop();
  } finally {
    await f.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
