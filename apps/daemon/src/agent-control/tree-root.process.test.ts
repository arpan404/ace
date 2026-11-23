import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { AgentControlOperation, ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { daemonFixture } from "./daemon-test-support.ts";
import { setup } from "./test-support.ts";

const runGit = promisify(execFile);
const ThreadResult = z.object({ threadId: ThreadId });
const signal = () => new AbortController().signal;

function conversationPort(h: ReturnType<typeof setup>) {
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "started"), h.clock.now);
  const context = { store: h.store, services: { workspaceActions: runtime }, signal: signal() };
  return createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(context, h.service, h.service.conversations),
  });
}

async function initRepo(repo: string) {
  await runGit("git", ["init"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "tree-root test\n");
  await runGit("git", ["add", "README.md"], { cwd: repo });
  await runGit(
    "git",
    ["-c", "user.name=ace", "-c", "user.email=ace@example.invalid", "commit", "-m", "initial"],
    { cwd: repo },
  );
}

test("delegated grandchildren and thread_start children report the top thread as treeRootId", async () => {
  const h = setup();
  const root = await h.parent();
  expect(h.store.getThread(root.threadId)?.treeRootId).toBeUndefined();

  const child = h.delegate(root, "child");
  await h.engine.flush();
  const childCaller = h.caller(child.childId);
  const grandchild = h.delegate(childCaller, "grandchild");
  await h.engine.flush();

  const port = conversationPort(h);
  const startedFromRoot = await port.execute(
    root,
    AgentControlOperation.parse({
      op: "thread.start",
      requestId: "start-from-root",
      title: "Root sibling",
      text: "Work beside root",
      provider: "claude",
      workspace: { kind: "project" },
    }),
    signal(),
  );
  const startedFromChild = await port.execute(
    childCaller,
    AgentControlOperation.parse({
      op: "thread.start",
      requestId: "start-from-child",
      title: "Child started",
      text: "Work from child",
      provider: "claude",
      workspace: { kind: "project" },
    }),
    signal(),
  );
  await h.engine.flush();

  const rootStartedId = ThreadResult.parse(startedFromRoot.data).threadId;
  const childStartedId = ThreadResult.parse(startedFromChild.data).threadId;

  expect(h.store.getThread(root.threadId)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(child.childId)?.treeRootId).toBe(root.threadId);
  expect(h.store.getThread(grandchild.childId)?.treeRootId).toBe(root.threadId);
  expect(h.store.getThread(rootStartedId)?.treeRootId).toBe(root.threadId);
  expect(h.store.getThread(childStartedId)?.treeRootId).toBe(root.threadId);

  // A stored thread from before treeRootId existed resolves its root lazily once loaded.
  const snapshot = join(h.home, "tree-root.sqlite");
  let source: DatabaseSync | undefined;
  h.store.atomic((db) => {
    source = db;
  });
  if (!source) throw new Error("Missing snapshot source");
  await backup(source, snapshot);
  await h.close();

  const db = new DatabaseSync(snapshot);
  try {
    db.prepare(
      "UPDATE threads SET transitions = json_remove(transitions, '$.treeRootId')",
    ).run();
  } finally {
    db.close();
  }

  const reopened = setup({}, snapshot);
  expect(reopened.store.getThread(root.threadId)?.treeRootId).toBeUndefined();
  expect(reopened.store.getThread(child.childId)?.treeRootId).toBe(root.threadId);
  expect(reopened.store.getThread(grandchild.childId)?.treeRootId).toBe(root.threadId);
  expect(reopened.store.getThread(rootStartedId)?.treeRootId).toBe(root.threadId);
  expect(reopened.store.getThread(childStartedId)?.treeRootId).toBe(root.threadId);
});

test("a handoff child reports its parent tree root even without delegatedBy", async () => {
  const f = await daemonFixture();
  try {
    await initRepo(f.h.home);
    const childResult = await f.call({
      op: "delegate_task",
      requestId: "before-handoff",
      provider: "claude",
      task: "Prepare handoff",
      role: "before-handoff",
    });
    expect(childResult.ok).toBe(true);
    const childId = ThreadResult.parse(childResult.data).threadId;
    const childAgentId = f.daemon.store.getThread(childId)?.rootAgentId;
    if (!childAgentId) throw new Error("Missing child rootAgentId");
    const handoff = await f.controls.port.execute(
      { threadId: childId, agentId: childAgentId },
      AgentControlOperation.parse({
        op: "thread.handoff",
        threadId: childId,
        requestId: "handoff-from-child",
        branch: "ace-handoff-tree-root",
      }),
      signal(),
    );
    expect(handoff.ok).toBe(true);
    const handoffId = ThreadResult.parse(handoff.data).threadId;
    const thread = f.daemon.store.getThread(handoffId);
    expect(thread?.delegatedBy).toBeUndefined();
    expect(thread?.treeRootId).toBe(f.caller.threadId);
  } finally {
    await f.daemon.close();
  }
}, 30_000);

test("a hidden Spade host thread is never the tree root for threads it delegates", async () => {
  const h = setup();
  const host = await h.parent();
  h.store.appendEvents(host.threadId, [
    { type: "thread.client.updated", changes: { host: "spade" } },
  ]);

  const direct = h.delegate(host, "spade-direct");
  await h.engine.flush();
  const grandchild = h.delegate(h.caller(direct.childId), "spade-grandchild");
  await h.engine.flush();

  expect(h.store.getThread(direct.childId)?.treeRootId).toBeUndefined();
  expect(h.store.getThread(grandchild.childId)?.treeRootId).toBe(direct.childId);
});
