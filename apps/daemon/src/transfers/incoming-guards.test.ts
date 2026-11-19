import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PinnedDirectory } from "@ace/workspace";
import { Device, HostId, WorkspaceId, type TransferBegin } from "@ace/protocol";
import { TargetRefusal } from "../machines/target-refusal.ts";
import { Store } from "../store.ts";
import type { TransferIdentities } from "./identity.ts";
import { IncomingTransfers } from "./incoming.ts";
import type { TargetProjects } from "./landing.ts";
import type { TransferArchive, TransferGit } from "./ports.ts";

/**
 * One file system call can be held, the next time it runs, so a test can land something in the
 * window where a transfer call waits on the disk.
 */
type Held = "removeQuietly" | "fileDigest" | "fileBytes";
const holds = vi.hoisted(() => {
  const next = new Map<string, { reached: () => void; until: Promise<void> }>();
  /** `run`, first waiting at a hold set for `name`, if there is one. */
  const holding =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const waiting = next.get(name);
      next.delete(name);
      if (waiting) {
        waiting.reached();
        await waiting.until;
      }
      return run(...args);
    };
  return { next, holding };
});
vi.mock("./files.ts", async (original) => {
  const real = await original<typeof import("./files.ts")>();
  return {
    ...real,
    removeQuietly: holds.holding("removeQuietly", real.removeQuietly),
    fileDigest: holds.holding("fileDigest", real.fileDigest),
    fileBytes: holds.holding("fileBytes", real.fileBytes),
  };
});

/** Holds the next call of `name`; `reached` resolves once one waits there. */
function hold(name: Held) {
  const reached = Promise.withResolvers<void>();
  const until = Promise.withResolvers<void>();
  holds.next.set(name, { reached: reached.resolve, until: until.promise });
  return { reached: reached.promise, release: until.resolve };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  holds.next.clear();
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
/** The device as its credential stands now: Projects can be taken away mid-call. */
function authority() {
  const state = { projects: true };
  const check = () => {
    if (!state.projects) throw new TargetRefusal("machine_forbidden", "No Projects here.");
    return device;
  };
  return { state, check };
}
const begin = (transferId: string): TransferBegin => ({
  op: "begin",
  transferId,
  origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
  method: "bundle",
  name: "app",
});
const byOrigin = (transferId: string): TransferBegin => ({
  ...begin(transferId),
  method: "remote",
  remote: { url: "https://git.example.com/app.git", normalized: "git.example.com/app" },
});
const bytes = Buffer.from("bundle bytes");
const file = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const identity = { id: "6f1d2a4e-8b3c-4d5e-9f60-718293a4b5c6", aliases: [] };

/** A target whose clone of the sender's origin fails, so a transfer by origin is reopened. */
const cloneFails = (root: string): Partial<TargetProjects> => ({
  parent: async (requested) => {
    const handle = PinnedDirectory.open(requested ?? root);
    return { path: requested ?? root, handle, close: async () => handle.close() };
  },
  clone: async () => {
    throw new Error("origin unreachable");
  },
});

/** The receiving side, with its Git and landing held until `release` is called. */
async function target(
  options: { projects?: (root: string) => Partial<TargetProjects>; clock?: { at: number } } = {},
) {
  const clock = options.clock ?? { at: 2 };
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-guards-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git: held<TransferGit>(gate),
    gitPolicy: { validateUrl: () => {} },
    archive: held<TransferArchive>(gate),
    projects: held<TargetProjects>(gate, { list: () => [], ...options.projects?.(root) }),
    threads: held(gate),
    // The sender's project is registered here already, so a commit naming it reads Git first.
    identities: held<TransferIdentities>(gate, {
      holders: () => [{ workspaceId: WorkspaceId.parse("workspace-held"), path: root }],
    }),
    now: () => clock.at,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  cleanup.push(async () => release());
  const state = (transferId: string) =>
    store.statement("SELECT state FROM transfer_incoming WHERE transfer_id=?").get(transferId)?.[
      "state"
    ];
  return {
    incoming,
    release,
    state,
    part: (id: string) => join(root, "incoming", `${id}.part`),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("a commit whose device loses Projects while it reads Git never starts the import", async () => {
  const { incoming, release, state } = await target();
  const { state: scopes, check } = authority();
  await incoming.call(device, begin("t-narrowed"), check);
  await incoming.chunk(device, "t-narrowed", 0, bytes, "code", check);
  // Admitted with Projects, then waits on the registration its identity names.
  const committing = incoming.call(
    device,
    { op: "commit", transferId: "t-narrowed", file, identity },
    check,
  );
  await settle();
  scopes.projects = false;
  release();
  await expect(committing).rejects.toMatchObject({ code: "machine_forbidden" });
  expect(state("t-narrowed")).toBe("receiving");
});

it("a chunk waiting on the disk when its device loses Projects never appends", async () => {
  const { incoming, part } = await target();
  const { state: scopes, check } = authority();
  await incoming.call(device, begin("t-queued"), check);
  // Admitted, then held reading what the transfer holds before it writes.
  const waiting = hold("fileBytes");
  const writing = incoming.chunk(device, "t-queued", 0, bytes, "code", check);
  await waiting.reached;
  scopes.projects = false;
  waiting.release();
  await expect(writing).rejects.toMatchObject({ code: "machine_forbidden" });
  // Not even an empty payload file is made for it.
  await expect(stat(part("t-queued"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("a stale commit whose digest fails after the transfer reopened never fails the new upload", async () => {
  const { incoming, state, part } = await target({ projects: cloneFails });
  await incoming.call(device, byOrigin("t-gen"));
  // A copy of the commit names an empty file and waits on its digest.
  const digesting = hold("fileDigest");
  const stale = incoming.call(device, {
    op: "commit",
    transferId: "t-gen",
    file: { bytes: 0, sha256: "0".repeat(64) },
  });
  await digesting.reached;
  // The other copy lands nothing (origin is unreachable): the whole repository is sent again.
  await incoming.call(device, { op: "commit", transferId: "t-gen" });
  await vi.waitFor(() => expect(state("t-gen")).toBe("receiving"));
  await incoming.chunk(device, "t-gen", 0, bytes);
  // Now the stale digest finishes: it is of another upload, so it decides nothing.
  digesting.release();
  await expect(stale).resolves.toMatchObject({ state: "receiving" });
  expect(state("t-gen")).toBe("receiving");
  expect(await readFile(part("t-gen"))).toEqual(bytes);
});

it("a begin of a transfer the sweep is still removing waits, so the sweep never takes its files", async () => {
  const clock = { at: 2 };
  const { incoming, part, state } = await target({ clock });
  await incoming.call(device, begin("t-again"));
  await incoming.chunk(device, "t-again", 0, bytes);
  await incoming.call(device, { op: "cancel", transferId: "t-again" });
  // Days later another begin sweeps the cancelled transfer and holds removing its files.
  clock.at = 3 * 24 * 60 * 60 * 1000;
  const removing = hold("removeQuietly");
  const sweeping = incoming.call(device, begin("t-other"));
  await removing.reached;
  // The sender begins the same id again and sends its first chunk as soon as it is answered.
  const sent = incoming
    .call(device, begin("t-again"))
    .then(() => incoming.chunk(device, "t-again", 0, bytes));
  await settle();
  removing.release();
  await sweeping;
  await sent;
  expect(state("t-again")).toBe("receiving");
  expect(await readFile(part("t-again"))).toEqual(bytes);
});

it("a transfer whose id ends like another's payload never reaches that payload's file", async () => {
  const { incoming } = await target();
  const other = Device.parse({ ...device, id: "device-other", name: "Studio" });
  const ignored = Buffer.from("ignored files");
  await incoming.call(device, begin("x"));
  await incoming.chunk(device, "x", 0, ignored, "ignored");
  // Another device's transfer is named as the first one's ignored payload would be on disk.
  await incoming.call(other, begin("x.ignored"));
  await expect(incoming.chunk(other, "x.ignored", 0, bytes)).resolves.toEqual({
    offset: bytes.length,
  });
  await incoming.call(other, { op: "cancel", transferId: "x.ignored" });
  // The first transfer still holds exactly what it was sent.
  await expect(incoming.call(device, { op: "status", transferId: "x" })).resolves.toMatchObject({
    state: "receiving",
    offset: 0,
    ignoredOffset: ignored.length,
  });
});

it("closing stops the sweep and waits for it, so nothing is swept once close has returned", async () => {
  const clock = { at: 2 };
  const { incoming, state } = await target({ clock });
  for (const id of ["t-old-1", "t-old-2"]) {
    await incoming.call(device, begin(id));
    await incoming.call(device, { op: "cancel", transferId: id });
  }
  // Days later a begin sweeps both, and holds removing the first one's files.
  clock.at = 3 * 24 * 60 * 60 * 1000;
  const removing = hold("removeQuietly");
  const sweeping = incoming.call(device, begin("t-next")).catch(() => undefined);
  await removing.reached;
  const closing = incoming.close();
  removing.release();
  await closing;
  const left = () => ["t-old-1", "t-old-2"].filter((id) => state(id) !== undefined);
  expect(left()).toHaveLength(1);
  await sweeping;
  await settle();
  expect(left()).toHaveLength(1);
});
