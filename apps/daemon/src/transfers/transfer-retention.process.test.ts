import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

const day = 24 * 60 * 60 * 1000;

it("an agent's result that never reached its thread survives retention and is delivered after a restart", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  await m.addProject(m.source, path);
  await m.source.call({ op: "transfer", machine: "studio", project: "app" });
  const transfer = await m.settled();
  expect(transfer.phase).toBe("completed");
  // A crash between settling and handing the result over leaves it undelivered.
  await vi.waitFor(() => {
    if (!m.source.daemon.transfers.outgoing.get(transfer.transferId)?.delivered)
      throw new Error("Not delivered yet");
  });
  m.source.daemon.store
    .statement("UPDATE transfer_outgoing SET delivered=0 WHERE transfer_id=?")
    .run(transfer.transferId);

  // The machine comes back two days later, past the 24-hour retention.
  m.source.h.clock.advance(m.source.h.clock.now() + 2 * day);
  await m.restartSource();

  await vi.waitFor(
    () => {
      const record = m.source.daemon.transfers.outgoing.get(transfer.transferId);
      expect(record?.transfer.phase).toBe("completed");
      expect(record?.delivered).toBe(true);
    },
    { timeout: 30_000, interval: 50 },
  );
});

it("records the options a transfer was started with, the ignored-files default resolved", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  await m.source.daemon.settings.set("remote.transferIgnoredFiles", false, { kind: "global" });
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
    parent: m.targetRoot,
  });
  const transfer = await m.settled();
  expect(transfer.options).toEqual({
    includeChanges: false,
    includeIgnored: false,
    parent: m.targetRoot,
  });
  expect(m.here.progress().every((entry) => entry.options?.includeIgnored === false)).toBe(true);
});
