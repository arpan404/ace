import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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

/** A target with one project, a checkout whose origin is `origin`. */
async function target(origin: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-incoming-origin-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  const path = join(root, "app");
  const unreached = () => Promise.reject(new Error("Not reached in this test"));
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
      parent: unreached,
      clone: unreached,
    } as Partial<TargetProjects> as TargetProjects,
    threads: {} as never,
    now: () => 2,
    log: () => {},
  });
  cleanup.push(() => incoming.close());
  return {
    /** The project here a transfer from `url` was set to land in, with the sender's own key. */
    async landing(url: string, senderKey: string) {
      const transferId = `t-${Math.random().toString(36).slice(2)}`;
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
