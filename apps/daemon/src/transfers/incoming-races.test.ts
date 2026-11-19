import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Device, HostId, WorkspaceId, type TransferBegin } from "@ace/protocol";
import { Store } from "../store.ts";
import type { TransferIdentities } from "./identity.ts";
import { IncomingTransfers } from "./incoming.ts";
import type { TargetProjects } from "./landing.ts";
import type { TransferArchive, TransferGit } from "./ports.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A dependency each test reaches only where it says; anything else waits on `gate` and fails. */
function held<T extends object>(gate: Promise<void>, own: Partial<T> = {}): T {
  return new Proxy(own as T, {
    get: (given, name) =>
      name in given
        ? Reflect.get(given, name)
        : async () => {
            await gate;
            throw new Error(`Not reached in this test: ${String(name)}`);
          },
  });
}

const device = Device.parse({
  id: "device-sender",
  name: "MacBook",
  scopes: ["read", "operate", "projects"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
});
const begin = (transferId: string): TransferBegin => ({
  op: "begin",
  transferId,
  origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
  method: "bundle",
  name: "app",
});
const bytes = Buffer.from("bundle bytes");
const file = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

/** The receiving side, with its Git and landing held until `release` is called. */
async function target() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-races-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const workspaceId = WorkspaceId.parse("workspace-held");
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git: held<TransferGit>(gate),
    archive: held<TransferArchive>(gate),
    projects: held<TargetProjects>(gate, { list: () => [] }),
    threads: held(gate),
    // The sender's project is registered here already, so commit reads that checkout first.
    identities: held<TransferIdentities>(gate, {
      holders: () => [{ workspaceId, path: root }],
    }),
    now: () => 2,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  return { incoming, release, part: (id: string) => join(root, "incoming", `${id}.part`) };
}

/** Lets every settled promise run its continuations. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("a cancel that lands while a commit is checking its file stays cancelled", async () => {
  const { incoming, release } = await target();
  await incoming.call(device, begin("t-cancel"));
  await incoming.chunk(device, "t-cancel", 0, bytes);
  // The commit waits on reading the registration its identity names.
  const committing = incoming.call(device, {
    op: "commit",
    transferId: "t-cancel",
    file,
    identity: { id: "6f1d2a4e-8b3c-4d5e-9f60-718293a4b5c6", aliases: [] },
  });
  await settle();
  await expect(
    incoming.call(device, { op: "cancel", transferId: "t-cancel" }),
  ).resolves.toMatchObject({ state: "cancelled" });
  release();
  await expect(committing).resolves.toMatchObject({ state: "cancelled" });
  await settle();
  await expect(
    incoming.call(device, { op: "status", transferId: "t-cancel" }),
  ).resolves.toMatchObject({ state: "cancelled" });
});

it("a second cancel answers only once the first has undone the transfer", async () => {
  const { incoming, release, part } = await target();
  await incoming.call(device, begin("t-twice"));
  await incoming.chunk(device, "t-twice", 0, bytes);
  // The import starts and waits on Git; the first cancel stops it and waits for it to end.
  await incoming.call(device, { op: "commit", transferId: "t-twice", file });
  const first = incoming.call(device, { op: "cancel", transferId: "t-twice" });
  await settle();
  let answered = false;
  const second = incoming.call(device, { op: "cancel", transferId: "t-twice" }).then((view) => {
    answered = true;
    return view;
  });
  await settle();
  expect(answered).toBe(false);
  release();
  await expect(second).resolves.toMatchObject({ state: "cancelled" });
  // By the time it answered, nothing of the transfer is left.
  await expect(stat(part("t-twice"))).rejects.toThrow();
  await expect(first).resolves.toMatchObject({ state: "cancelled" });
});

it("two copies of a begin sent at once both get the one transfer", async () => {
  const { incoming } = await target();
  const [one, two] = await Promise.all([
    incoming.call(device, begin("t-begin")),
    incoming.call(device, begin("t-begin")),
  ]);
  expect(one).toMatchObject({ transferId: "t-begin", state: "receiving" });
  expect(two).toMatchObject({ transferId: "t-begin", state: "receiving" });
});
