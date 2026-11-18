import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { ThreadId } from "@ace/protocol";
import type { TransferTransport } from "./client.ts";
import { repositoryWithOrigin, type Machines } from "./transfer-test-support.ts";

/** What a side's provider was sent for one thread. */
export const sentTo = (side: Machines["source"], threadId: ThreadId) =>
  side.h.attempts.filter((attempt) => attempt.threadId === threadId).map((a) => a.text);

/** A thread whose agent is in the middle of its turn (the scripted Claude keeps it running). */
export async function workingThread(m: Machines) {
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await writeFile(join(path, "wip.txt"), "half done\n");
  const workspaceId = await m.addProject(m.source, path);
  const created = m.source.controls.delegations.command("long-job", {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    title: "Login bug",
    access: "full-access",
    input: [{ type: "text", text: "Fix the login bug on the settings page" }],
  });
  const threadId = created.threadId;
  if (!threadId) throw new Error(`Not created: ${created.error}`);
  await m.source.daemon.engine?.flush();
  expect(m.source.daemon.store.getThread(threadId)?.status.state).toBe("working");
  return { path, threadId };
}

export const continueOn = (m: Machines, threadId: ThreadId) =>
  m.here.command({
    type: "thread.continueOn",
    threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });

/** Calls the source makes to the target, by the operation each carries. */
export const op = (route: Parameters<TransferTransport>[1]) =>
  route.method === "PUT"
    ? `chunk:${new URL(route.path, "https://x").searchParams.get("part") ?? "code"}`
    : String(JSON.parse(String(route.body)).op);
