import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startRelay } from "@ace/relay";
import { selfSignedCertificate } from "../self-signed-certificate.ts";
import { git, transferMachines } from "./transfer-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
// The relay's TLS certificate is self-signed: what proves the machine is the relay host key the
// link pins, inside the end to end encrypted stream.
const trust = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
beforeEach(() => {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
});
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  if (trust === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = trust;
}, 60_000);

it("moves a project to a machine linked through the person's relay only, its bytes in relay pieces", async () => {
  const certificate = selfSignedCertificate({ commonName: "127.0.0.1", days: 2, now: new Date() });
  const relay = await startRelay({ tls: { cert: certificate.cert, key: certificate.key } });
  cleanup.push(() => relay.close());
  if (!relay.tlsPort) throw new Error("The relay serves no TLS");
  const m = await transferMachines({ relayOnly: `wss://127.0.0.1:${relay.tlsPort}` });

  // A repository without a remote travels as a bundle of every commit: several MiB of it, so the
  // upload takes many chunks and each goes through the relay in pieces.
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  const data = randomBytes(6 * 1024 * 1024);
  await writeFile(join(path, "data.bin"), data);
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "data");
  const workspaceId = await m.addProject(m.source, path);

  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
    includeIgnored: false,
  });
  expect(receipt.ok).toBe(true);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
  const landed = transfer.result;
  if (!landed) throw new Error("No result");
  expect(m.target.daemon.store.getWorkspacePath(landed.workspaceId)).toBe(landed.path);
  expect(await git(landed.path, "log", "-1", "--format=%s")).toBe("data");
  expect((await readFile(join(landed.path, "data.bin"))).equals(data)).toBe(true);
}, 120_000);
