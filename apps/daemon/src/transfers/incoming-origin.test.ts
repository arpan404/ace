import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PinnedDirectory } from "@ace/workspace";
import { normalizeRemoteUrl } from "@ace/git/remote-url";
import { Device, HostId, WorkspaceId, type TransferBegin } from "@ace/protocol";
import { Store } from "../store.ts";
import { IncomingTransfers } from "./incoming.ts";
import type { TargetProjects } from "./landing.ts";
import type { TransferArchive, TransferGit } from "./ports.ts";

// Which project here a transfer by origin lands in: the one whose origin is the sender's
// repository, by this machine's own reading of the sender's URL.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const device = Device.parse({
  id: "device-sender",
  name: "MacBook",
  scopes: ["read", "operate", "projects"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
});
const project = WorkspaceId.parse("workspace-here");
const unreached = () => Promise.reject(new Error("Not reached in this test"));
/** A held folder no step of these landings may use. */
const untouchable = new Proxy({} as PinnedDirectory, {
  get: (_target, name) => {
    throw new Error(`The parent's descriptor was used: ${String(name)}`);
  },
});

/** A target with one project, a checkout whose origin is `origin`. */
async function target(origin: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-origin-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const path = join(root, "app");
  const git = {
    transferOrigin: async (at: string) =>
      at === path ? { url: origin, normalized: normalizeRemoteUrl(origin) } : undefined,
    checkoutFacts: async (at: string) =>
      at === path ? { remotes: [normalizeRemoteUrl(origin)], subpath: "" } : undefined,
  } as Partial<TransferGit> as TransferGit;
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git,
    gitPolicy: { validateUrl: () => {} },
    archive: {} as TransferArchive,
    projects: {
      list: () => [{ workspaceId: project, path }],
      // A folder for the new project is only reserved, by name: origin can't be cloned here
      // (`clone` fails at once, as with no SSH key for it), so nothing is ever made through the
      // parent's descriptor, and this needs no native build. Any use of it fails the test.
      parent: async (requested) => ({
        path: requested ?? root,
        handle: untouchable,
        close: async () => {},
      }),
      clone: unreached,
    } as Partial<TargetProjects> as TargetProjects,
    threads: {} as never,
    now: () => 2,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  return {
    /** The transfer's row as it stands. */
    row: (transferId: string) =>
      store
        .statement("SELECT state,method,has_origin FROM transfer_incoming WHERE transfer_id=?")
        .get(transferId),
    /** Commit a transfer by origin, with nothing uploaded. */
    commit: (transferId: string) =>
      incoming.call(device, { op: "commit", transferId }, () => device),
    /** The project here a transfer from `url` was set to land in, with the sender's own key. */
    async landing(
      url: string,
      senderKey: string,
      transferId = `t-${Math.random().toString(36).slice(2)}`,
    ) {
      const begin: TransferBegin = {
        op: "begin",
        transferId,
        origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
        method: "remote",
        name: "app",
        remote: { url, normalized: senderKey },
      };
      await incoming.call(device, begin, () => device);
      return store
        .statement("SELECT workspace_id FROM transfer_incoming WHERE transfer_id=?")
        .get(transferId)?.["workspace_id"];
    },
  };
}

it("never lands an SSH origin from the root in a checkout of the same path from a home", async () => {
  const here = await target("git@forge:team/app.git");
  // An older sender keyed both spellings `forge/team/app`.
  expect(await here.landing("ssh://git@forge/team/app.git", "forge/team/app")).toBeNull();
  expect(await here.landing("ssh://git@forge/~/team/app.git", "forge/team/app")).toBe(project);
});

it("lands every spelling of a public forge's repository in the one checkout of it", async () => {
  const here = await target("git@github.com:o/r.git");
  expect(await here.landing("ssh://git@github.com/o/r", "github.com/o/r")).toBe(project);
  expect(await here.landing("https://github.com/o/r.git", "github.com/o/r")).toBe(project);
});

/**
 * A transfer begun under an older build, which chose the checkout here (origin
 * `git@forge:team/app.git`) for the sender's `url` and kept the sender's own key, `senderKey`,
 * with no `v2:`. Its commit comes after the upgrade: what Git was asked, by folder, and every
 * new folder the landing went for.
 */
async function chosenBeforeUpgrade(url: string, senderKey: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-rechoose-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const path = join(root, "app");
  const origin = "git@forge:team/app.git";
  /** Every Git call, by the folder it was for. */
  const touched: string[] = [];
  const git = new Proxy({} as TransferGit, {
    get: (_target, name) => async (at: unknown) => {
      touched.push(`${String(name)} ${String(at)}`);
      if (name === "transferOrigin")
        return at === path ? { url: origin, normalized: normalizeRemoteUrl(origin) } : undefined;
      return undefined;
    },
  });
  const newFolders: string[] = [];
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git,
    gitPolicy: { validateUrl: () => {} },
    archive: {} as TransferArchive,
    projects: {
      list: () => [{ workspaceId: project, path }],
      parent: async (requested: string | undefined) => {
        newFolders.push(requested ?? root);
        throw new Error("no room for a new folder in this test");
      },
      clone: unreached,
    } as Partial<TargetProjects> as TargetProjects,
    threads: {} as never,
    now: () => 2,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  const begin: TransferBegin = {
    op: "begin",
    transferId: "t-before",
    origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
    method: "remote",
    name: "app",
    remote: { url, normalized: senderKey },
  };
  store
    .statement(
      "INSERT INTO transfer_incoming (transfer_id,device_id,state,method,has_origin,begin,workspace_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("t-before", device.id, "receiving", "remote", 1, JSON.stringify(begin), project, 1, 1);
  await incoming.call(device, { op: "commit", transferId: "t-before", head: "a".repeat(40) });
  return {
    path,
    touched,
    newFolders,
    here: () => touched.filter((call) => call.endsWith(` ${path}`)),
  };
}

it("re-checks a project chosen before an upgrade, and never lands in one whose origin isn't the sender's", async () => {
  // `/team/app` from the root: another repository than the checkout's, from a home.
  const landing = await chosenBeforeUpgrade("ssh://git@forge/team/app.git", "forge/team/app");
  await expect.poll(() => landing.newFolders.length).toBe(1);
  // Its origin was read, and nothing else was done there: the work went for a new folder.
  expect(landing.here()).toEqual([`transferOrigin ${landing.path}`]);
});

it("re-checks by URL alone, so an older sender's key without v2 still lands in the same repository", async () => {
  // The same repository, spelled from the home; the older sender's key has no `v2:`.
  const landing = await chosenBeforeUpgrade("ssh://git@forge/~/team/app.git", "forge/team/app");
  await expect.poll(() => landing.here().length).toBeGreaterThan(1);
  // The checkout here was kept: past its origin, the landing went on in it.
  expect(landing.here()[0]).toBe(`transferOrigin ${landing.path}`);
  expect(landing.newFolders).toEqual([]);
});

it("a self-hosted forge's SSH origin never lands in its HTTPS checkout, and is sent whole instead", async () => {
  // Known limitation: outside the public forges, scp and HTTPS spellings may be one repository
  // on a GitLab or Gitea server, but nothing here can tell such a server from a plain SSH host.
  const here = await target("https://gitlab.corp/team/app.git");
  const sent = "t-self-hosted";
  expect(
    await here.landing("git@gitlab.corp:team/app.git", "gitlab.corp/team/app", sent),
  ).toBeNull();
  // Origin can't be cloned here either: the sender is asked for the whole repository, which
  // lands as a fresh copy, never in the checkout above.
  await here.commit(sent);
  await vi.waitFor(() =>
    expect(here.row(sent)).toMatchObject({ state: "receiving", method: "bundle", has_origin: 0 }),
  );
});
