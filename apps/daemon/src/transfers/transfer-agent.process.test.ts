import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

type Machines = Awaited<ReturnType<typeof transferMachines>>;

/** A project named `app` with a commit origin lacks, so its transfer uploads a bundle. */
async function project(m: Machines) {
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  return m.addProject(m.source, path);
}

it("an agent's transfer holds its thread working and delivers the result as a new turn", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      if (route.method === "PUT") await held;
      return inner(profile, route, options);
    },
  });
  await project(m);
  const caller = m.source.caller.threadId;
  const listed = await m.source.call({ op: "machines" });
  expect(listed.data).toMatchObject({ machines: [{ machine: "studio", transfers: true }] });

  const started = await m.source.call({ op: "transfer", machine: "studio", project: "app" });
  expect(started).toMatchObject({ ok: true, data: { machine: "studio" } });
  // While the bytes are held back, the caller's tree is not done.
  await m.source.daemon.engine?.flush();
  const during = m.source.daemon.store.getThread(caller);
  expect(during?.status.state).not.toBe("done");
  expect(during?.live?.backgroundTaskCount).toBe(1);

  release();
  const transfer = await m.settled();
  expect(transfer.phase).toBe("completed");
  await vi.waitFor(
    async () => {
      await m.source.daemon.engine?.flush();
      const sent = m.source.h.attempts
        .filter((attempt) => attempt.threadId === caller)
        .map((attempt) => attempt.text)
        .join("\n");
      if (!sent.includes(`Transfer ${transfer.transferId} to Studio completed`))
        throw new Error("Result not delivered");
      const after = m.source.daemon.store.getThread(caller);
      expect(after?.live?.backgroundTaskCount ?? 0).toBe(0);
      expect(after?.status.state).toBe("done");
    },
    { timeout: 30_000, interval: 50 },
  );
});

it("refuses an agent's transfer while the setting is off, leaving the person's own transfers alone", async () => {
  const m = await transferMachines();
  const workspaceId = await project(m);
  await m.source.daemon.settings.set("remote.agentTransfers", false, { kind: "global" });

  await expect(
    m.source.call({ op: "transfer", machine: "studio", project: "app" }),
  ).rejects.toMatchObject({ code: "transfers_off" });
  expect(m.source.daemon.transfers.outgoing.list()).toEqual([]);

  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  expect(receipt.ok).toBe(true);
  expect((await m.settled()).phase).toBe("completed");
});
