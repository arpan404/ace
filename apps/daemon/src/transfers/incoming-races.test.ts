import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PinnedDirectory } from "@ace/workspace";
import { Device, HostId, WorkspaceId, type TransferBegin } from "@ace/protocol";
import { Store } from "../store.ts";
import type { TransferIdentities } from "./identity.ts";
import { IncomingTransfers } from "./incoming.ts";
import type { TargetProjects } from "./landing.ts";
import type { TransferArchive, TransferGit } from "./ports.ts";

/**
 * Removing a transfer's files can be held once, at the file system, so a test can land a call in
 * the middle of another's clean-up: the window two writers of a transfer's state race in.
 */
const removal = vi.hoisted(() => ({
  hold: undefined as { reached: () => void; until: Promise<void> } | undefined,
}));
vi.mock("./files.ts", async (original) => {
  const real = await original<typeof import("./files.ts")>();
  return {
    ...real,
    removeQuietly: async (path: string) => {
      const hold = removal.hold;
      removal.hold = undefined;
      if (hold) {
        hold.reached();
        await hold.until;
      }
      return real.removeQuietly(path);
    },
  };
});

/** Holds the next file removal; `reached` resolves once a removal waits there. */
function holdRemoval() {
  const reached = Promise.withResolvers<void>();
  const until = Promise.withResolvers<void>();
  removal.hold = { reached: reached.resolve, until: until.promise };
  return { reached: reached.promise, release: until.resolve };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/**
 * A dependency each test reaches only where it says; anything else waits on `gate` and fails.
 * `reached` names what was called that way.
 */
function held<T extends object>(gate: Promise<void>, own: Partial<T> = {}, reached?: string[]): T {
  return new Proxy(own as T, {
    get: (given, name) =>
      name in given
        ? Reflect.get(given, name)
        : async () => {
            reached?.push(String(name));
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
async function target(
  options: { projects?: (root: string) => Partial<TargetProjects>; clock?: { at: number } } = {},
) {
  const clock = options.clock ?? { at: 2 };
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-races-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const workspaceId = WorkspaceId.parse("workspace-held");
  const reached: string[] = [];
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git: held<TransferGit>(gate, {}, reached),
    gitPolicy: { validateUrl: () => {} },
    archive: held<TransferArchive>(gate),
    projects: held<TargetProjects>(gate, { list: () => [], ...options.projects?.(root) }),
    threads: held(gate),
    // The sender's project is registered here already, so commit reads that checkout first.
    identities: held<TransferIdentities>(gate, {
      holders: () => [{ workspaceId, path: root }],
    }),
    now: () => clock.at,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  // Released before anything closes, so a failed assertion never strands teardown on it.
  cleanup.push(async () => release());
  /** The transfer's rows as stored: how many, and the state of the first. */
  const stored = (transferId: string) => {
    const rows = store
      .statement("SELECT state FROM transfer_incoming WHERE transfer_id=?")
      .all(transferId);
    return { rows: rows.length, state: rows[0]?.["state"] };
  };
  return {
    incoming,
    release,
    stored,
    reached,
    part: (id: string) => join(root, "incoming", `${id}.part`),
  };
}

/** Lets every settled promise run its continuations. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("a cancel that lands while a commit is checking its file stays cancelled", async () => {
  const { incoming, release, stored } = await target();
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
  expect(stored("t-cancel").state).toBe("cancelled");
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
  const { incoming, stored } = await target();
  const [one, two] = await Promise.all([
    incoming.call(device, begin("t-begin")),
    incoming.call(device, begin("t-begin")),
  ]);
  expect(one).toMatchObject({ transferId: "t-begin", state: "receiving" });
  expect(two).toMatchObject({ transferId: "t-begin", state: "receiving" });
  expect(stored("t-begin")).toEqual({ rows: 1, state: "receiving" });
});

const damaged = { ...file, sha256: "0".repeat(64) };

it("a damaged upload fails the transfer before its files go, so a sound copy of the commit never starts it", async () => {
  const { incoming, stored } = await target();
  await incoming.call(device, begin("t-damaged"));
  await incoming.chunk(device, "t-damaged", 0, bytes);
  const removing = holdRemoval();
  const bad = incoming.call(device, { op: "commit", transferId: "t-damaged", file: damaged });
  await removing.reached;
  // A copy with the right digest comes while the damaged one's files are being removed.
  const sound = await incoming.call(device, { op: "commit", transferId: "t-damaged", file });
  removing.release();
  await bad;
  expect(sound.state).toBe("failed");
  expect(stored("t-damaged").state).toBe("failed");
});

it("a cancel during a damaged upload's clean-up answers with what the transfer ended as", async () => {
  const { incoming, stored } = await target();
  await incoming.call(device, begin("t-ended"));
  await incoming.chunk(device, "t-ended", 0, bytes);
  const removing = holdRemoval();
  const bad = incoming.call(device, { op: "commit", transferId: "t-ended", file: damaged });
  await removing.reached;
  const cancelled = await incoming.call(device, { op: "cancel", transferId: "t-ended" });
  removing.release();
  await bad;
  // The damaged upload claimed the failure first: the cancel comes too late and says so.
  expect(cancelled.state).toBe("failed");
  expect(stored("t-ended").state).toBe("failed");
});

it("closing waits for a cancel still undoing its transfer", async () => {
  const { incoming, release, part } = await target();
  await incoming.call(device, begin("t-close"));
  await incoming.chunk(device, "t-close", 0, bytes);
  // The import waits on Git; the cancel waits for the import, then removes the files.
  await incoming.call(device, { op: "commit", transferId: "t-close", file });
  let undone = false;
  const cancelling = incoming.call(device, { op: "cancel", transferId: "t-close" }).then(() => {
    undone = true;
  });
  await settle();
  const closing = incoming.close();
  release();
  await closing;
  expect(undone).toBe(true);
  await expect(stat(part("t-close"))).rejects.toThrow();
  await cancelling;
});

/**
 * A target whose clone of the sender's origin fails, so a transfer by origin lands nowhere and
 * is reopened for the whole repository as a bundle.
 */
const cloneFails = (root: string): Partial<TargetProjects> => ({
  parent: async (requested) => {
    const handle = PinnedDirectory.open(requested ?? root);
    return { path: requested ?? root, handle, close: async () => handle.close() };
  },
  clone: async () => {
    throw new Error("origin unreachable");
  },
});
const byOrigin = (transferId: string): TransferBegin => ({
  ...begin(transferId),
  method: "remote",
  remote: { url: "https://git.example.com/app.git", normalized: "git.example.com/app" },
});
const stateOf = async (incoming: IncomingTransfers, transferId: string) =>
  (await incoming.call(device, { op: "status", transferId })).state;

it("a transfer reopened for the whole repository says receiving only once its old upload is gone", async () => {
  const { incoming, reached } = await target({ projects: cloneFails });
  await incoming.call(device, byOrigin("t-reopen"));
  const removing = holdRemoval();
  await incoming.call(device, { op: "commit", transferId: "t-reopen" });
  await removing.reached;
  // Still landing its first attempt: no upload may start yet.
  expect(await stateOf(incoming, "t-reopen")).toBe("importing");
  removing.release();
  await vi.waitFor(async () => expect(await stateOf(incoming, "t-reopen")).toBe("receiving"));
  // The whole repository then comes, and its import starts.
  await incoming.chunk(device, "t-reopen", 0, bytes);
  await expect(
    incoming.call(device, { op: "commit", transferId: "t-reopen", file }),
  ).resolves.toMatchObject({ state: "importing" });
  await vi.waitFor(() => expect(reached.length).toBeGreaterThan(0));
});

it("a commit checked against an upload that was reopened meanwhile never claims the new one", async () => {
  const { incoming, release, stored } = await target({ projects: cloneFails });
  await incoming.call(device, byOrigin("t-stale"));
  // A copy of the commit names the sender's project, so it reads that checkout and waits there.
  const stale = incoming.call(device, {
    op: "commit",
    transferId: "t-stale",
    identity: { id: "6f1d2a4e-8b3c-4d5e-9f60-718293a4b5c6", aliases: [] },
  });
  await settle();
  // The other copy lands nothing (origin is unreachable) and the transfer is reopened.
  await incoming.call(device, { op: "commit", transferId: "t-stale" });
  await vi.waitFor(async () => expect(await stateOf(incoming, "t-stale")).toBe("receiving"));
  release();
  await expect(stale).resolves.toMatchObject({ state: "receiving" });
  expect(stored("t-stale").state).toBe("receiving");
});

it("the retention sweep and a commit that comes while it removes files agree on the transfer", async () => {
  const clock = { at: 2 };
  const { incoming, stored } = await target({ clock });
  await incoming.call(device, begin("t-sweep"));
  await incoming.chunk(device, "t-sweep", 0, bytes);
  // Days later the next begin sweeps, and holds while removing the first transfer's files.
  clock.at = 3 * 24 * 60 * 60 * 1000;
  const removing = holdRemoval();
  const sweeping = incoming.call(device, begin("t-next"));
  await removing.reached;
  const committed = await incoming
    .call(device, { op: "commit", transferId: "t-sweep", file })
    .then((view) => view.state)
    .catch(() => "refused");
  removing.release();
  await sweeping;
  // The sweep claimed it first: the commit is refused, and the transfer is gone. Never a commit
  // told it is importing a transfer whose row and files the sweep then removes.
  expect(committed).toBe("refused");
  expect(stored("t-sweep").rows).toBe(0);
});
