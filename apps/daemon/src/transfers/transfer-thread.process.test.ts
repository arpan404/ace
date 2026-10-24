import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProviderKind, type ThreadId } from "@ace/protocol";
import {
  finishedThread,
  git,
  repositoryWithOrigin,
  transferMachines,
  type Machines,
} from "./transfer-test-support.ts";

/** What the target's provider was sent for one thread. */
const sentTo = (m: Machines, threadId: ThreadId) =>
  m.target.h.attempts.filter((attempt) => attempt.threadId === threadId).map((a) => a.text);

it("continues a thread on another machine from its history, without starting a turn there", async () => {
  const m = await transferMachines();
  const source = await finishedThread(m, "Fix the login bug on the settings page");

  const receipt = await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
    // Not installed there: the thread starts on that machine's default instead.
    provider: "pi",
  });
  expect(receipt).toMatchObject({ ok: true, threadId: source.threadId });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", kind: "thread" });
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");

  const there = m.target.daemon.store.getThread(newId);
  const engine = m.target.daemon.engine;
  const installed = ProviderKind.options.find(
    (kind) => engine?.providerAvailability(kind).installed,
  );
  expect(there).toMatchObject({
    title: "Login bug (from MacBook)",
    provider: installed,
    workspaceId: transfer.result?.workspaceId,
    details: {
      mode: "local",
      continuedFrom: { name: "MacBook", threadId: source.threadId },
    },
  });
  expect(sentTo(m, newId)).toEqual([]);
  expect(await git(transfer.result?.path ?? "", "status", "--porcelain")).toBe("?? wip.txt");
  // The source thread records where the work went.
  expect(m.source.daemon.store.getThread(source.threadId)?.details?.continuedOn).toMatchObject({
    hostId: m.targetHostId,
    threadId: newId,
  });

  // The person's next message there carries the history in front of it.
  m.target.controls.delegations.command("next-there", {
    type: "thread.send",
    threadId: newId,
    input: [{ type: "text", text: "Carry on" }],
  });
  await engine?.flush();
  await vi.waitFor(() => {
    const sent = sentTo(m, newId).join("\n");
    if (!sent.includes("Carry on")) throw new Error("Not sent yet");
    expect(sent).toContain("Context handoff");
    expect(sent).toContain("Fix the login bug on the settings page");
    expect(sent).toContain("continues one from MacBook");
  });
});

it("refuses to continue a thread whose tree is still working", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const created = m.source.controls.delegations.command("busy", {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    access: "full-access",
    input: [{ type: "text", text: "Long job" }],
  });
  if (!created.threadId) throw new Error("Not created");
  await m.source.daemon.engine?.flush();
  expect(m.source.daemon.store.getThread(created.threadId)?.status.state).not.toBe("done");
  const receipt = await m.here.command({
    type: "thread.continueOn",
    threadId: created.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  expect(receipt).toMatchObject({ ok: false, error: "thread_busy" });
  expect(m.source.daemon.transfers.outgoing.list()).toEqual([]);
});

it("continues a thread whose folder isn't a Git repository, with the new thread there", async () => {
  const m = await transferMachines();
  const folder = join(m.sourceRoot, "notes");
  await mkdir(folder);
  await writeFile(join(folder, "plan.md"), "the plan\n");
  const source = await finishedThread(m, "Write up the plan", folder);

  await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "archive", kind: "thread" });
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");
  expect(await readFile(join(transfer.result?.path ?? "", "plan.md"), "utf8")).toBe("the plan\n");
  expect(m.target.daemon.store.getThread(newId)).toMatchObject({
    workspaceId: transfer.result?.workspaceId,
    details: { continuedFrom: { name: "MacBook", threadId: source.threadId } },
  });
  expect(m.source.daemon.store.getThread(source.threadId)?.details?.continuedOn).toMatchObject({
    threadId: newId,
  });
  // The thread there is the result: a cancel now is too late.
  expect(await m.here.request({ op: "cancel", transferId: transfer.transferId })).toMatchObject({
    kind: "error",
    code: "too_late",
  });
});
