import { stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Device, HostId, maxTransferBytes, transferChunkBytes } from "@ace/protocol";
import { transferMachines } from "./transfer-test-support.ts";

it("a target refuses bytes past the 20 GiB cap, counting the code and the ignored files together", async () => {
  const m = await transferMachines();
  const incoming = m.target.daemon.transfers.incoming;
  const device = Device.parse({
    id: "device-sender",
    name: "MacBook",
    scopes: ["read", "operate", "projects"],
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  });
  const transferId = "transfer-cap";
  await incoming.call(device, {
    op: "begin",
    transferId,
    origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
    method: "bundle",
    name: "app",
  });
  // The code payload already holds all but a few bytes of the cap (a sparse file, so no disk).
  const directory = join(m.target.h.home, "daemon", "transfers", "incoming");
  const code = maxTransferBytes - 16;
  await incoming.chunk(device, transferId, 0, Buffer.from("x"));
  await truncate(join(directory, `${transferId}.part`), code);

  const data = Buffer.alloc(Math.min(transferChunkBytes, 1024));
  await expect(incoming.chunk(device, transferId, 0, data, "ignored")).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(incoming.chunk(device, transferId, code, data)).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(stat(join(directory, `${transferId}.ignored.part`))).rejects.toThrow();
  expect((await stat(join(directory, `${transferId}.part`))).size).toBe(code);
  // Up to the cap is still taken.
  expect(await incoming.chunk(device, transferId, 0, Buffer.alloc(16), "ignored")).toEqual({
    offset: 16,
  });
});
