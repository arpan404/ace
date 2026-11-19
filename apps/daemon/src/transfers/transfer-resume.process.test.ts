import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { transferChunkBytes } from "@ace/protocol";
import { MachineFailure, MachineTimeout } from "../machines/transport.ts";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A project with a commit origin lacks, big enough to take several chunks. */
async function largeProject(root: string) {
  const { path } = await repositoryWithOrigin(root, "big");
  const data = randomBytes(2 * transferChunkBytes + 1024 * 1024);
  await writeFile(join(path, "data.bin"), data);
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "data");
  return { path, digest: digest(data) };
}

it("resumes from the acknowledged offset after a connection drops mid-upload", async () => {
  let puts = 0;
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      const answer = await inner(profile, route, options);
      // The second chunk reached the target, but its answer is lost.
      if (route.method === "PUT" && ++puts === 2) throw new MachineFailure("disconnected");
      return answer;
    },
  });
  const { path, digest: sent } = await largeProject(m.sourceRoot);
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "remote" });
  expect(digest(await readFile(join(transfer.result?.path ?? "", "data.bin")))).toBe(sent);
  const bytes = m.here.progress().map((entry) => entry.sentBytes);
  expect(bytes).toEqual([...bytes].toSorted((a, b) => a - b));
});

it("a chunk that times out on a slow link is sent again smaller, from the acknowledged offset", async () => {
  const puts: { offset: number; bytes: number }[] = [];
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      if (route.method !== "PUT") return inner(profile, route, options);
      const offset = Number(new URL(route.path, profile.origin).searchParams.get("offset"));
      puts.push({ offset, bytes: Buffer.byteLength(route.body) });
      // The second chunk reaches the target, but its answer doesn't come in time.
      const answer = await inner(profile, route, options);
      if (puts.length === 2) throw new MachineTimeout("disconnected");
      return answer;
    },
  });
  const { path, digest: sent } = await largeProject(m.sourceRoot);
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "remote" });
  expect(digest(await readFile(join(transfer.result?.path ?? "", "data.bin")))).toBe(sent);
  const [, timedOut, retry] = puts;
  if (!timedOut || !retry) throw new Error("The upload never retried");
  // Sent again from where it was, as a smaller piece.
  expect(retry.offset).toBe(timedOut.offset);
  expect(retry.bytes).toBeLessThan(timedOut.bytes);
  // Each piece starts at what the target last acknowledged: never behind it, never past it.
  const offsets = puts.map((put) => put.offset);
  expect(offsets).toEqual([...offsets].toSorted((a, b) => a - b));
});

it("carries on after the sending machine restarts mid-upload", async () => {
  let puts = 0;
  const m = await transferMachines({
    transport: (inner) => (profile, route, options) => {
      // The second chunk never answers: the machine stops while it waits.
      if (route.method === "PUT" && ++puts === 2)
        return new Promise((_, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new MachineFailure("disconnected")),
          ),
        );
      return inner(profile, route, options);
    },
  });
  const { path, digest: sent } = await largeProject(m.sourceRoot);
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const [started] = m.source.daemon.transfers.outgoing.list();
  if (!started) throw new Error("No transfer");
  await vi.waitFor(
    () => {
      const row = m.source.daemon.transfers.outgoing.get(started.transferId);
      if ((row?.transfer.sentBytes ?? 0) === 0) throw new Error("First chunk not sent");
    },
    { timeout: 30_000, interval: 20 },
  );
  await m.restartSource();
  const transfer = await m.settled(started.transferId);
  expect(transfer).toMatchObject({ phase: "completed", transferId: started.transferId });
  expect(digest(await readFile(join(transfer.result?.path ?? "", "data.bin")))).toBe(sent);
});
