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
  const caller = m.source.caller.threadId;
  await m.source.call({ op: "transfer", machine: "studio", project: "app" });
  const transfer = await m.settled();
  expect(transfer.phase).toBe("completed");
  const key = `transfer-result:${transfer.transferId}`;
  /** What the calling thread stored since `since` about this transfer's result. */
  const handedOver = (since: number) =>
    m.source.daemon.store
      .statement(
        "SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND at>=? AND instr(payload, ?)>0",
      )
      .get(caller, since, key)?.["n"];
  await vi.waitFor(() => {
    if (!m.source.daemon.transfers.outgoing.get(transfer.transferId)?.delivered)
      throw new Error("Not delivered yet");
    expect(handedOver(0)).toBeGreaterThan(0);
  });
  // A crash between settling and handing the result over leaves it undelivered. As the store
  // holds it then: the row undelivered, so open and not expiring in its side tables (ADR 0170),
  // all in one transaction as every write of the row keeps them, and no receipt of the hand-over.
  const { store } = m.source.daemon;
  store.atomic(() => {
    for (const table of ["command_receipts", "intents"])
      store.statement(`DELETE FROM ${table} WHERE command_id=?`).run(key);
    store
      .statement("UPDATE transfer_outgoing SET delivered=0 WHERE transfer_id=?")
      .run(transfer.transferId);
    store
      .statement("DELETE FROM transfer_outgoing_expiry WHERE transfer_id=?")
      .run(transfer.transferId);
    store
      .statement("INSERT OR IGNORE INTO transfer_outgoing_open (transfer_id) VALUES (?)")
      .run(transfer.transferId);
  });

  // The machine comes back two days later, past the 24-hour retention.
  m.source.h.clock.advance(m.source.h.clock.now() + 2 * day);
  const restarted = m.source.h.clock.now();
  await m.restartSource();

  await vi.waitFor(
    () => {
      const record = m.source.daemon.transfers.outgoing.get(transfer.transferId);
      expect(record?.transfer.phase).toBe("completed");
      expect(record?.delivered).toBe(true);
      // Handed to the thread that asked for it again, after the restart: its input is queued.
      expect(handedOver(restarted)).toBeGreaterThan(0);
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
