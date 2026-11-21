import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandId, HostId, ThreadId, Transfer, WorkspaceId } from "@ace/protocol";
import { MachineFailure } from "../machines/transport.ts";
import { Store } from "../store.ts";
import { ThreadOwnership } from "./live/ownership.ts";
import { LiveSource, type LiveSourcePorts } from "./live/source.ts";
import { OutgoingRows } from "./outgoing-rows.ts";
import { OutgoingTransfers, type OutgoingDeps } from "./outgoing.ts";

/*
 * A transfer whose answer was lost, and the links to its machine changing under it: unlinked,
 * linked again as a new pairing, or another machine taking its old name. The other machines are
 * fakes at the transport; the rows, the ownership record and the live move's hold are real.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Profile = { id: string; name: string; hostId?: string; deviceId: string };
type Call = { op: string; transferId?: string };
/** A machine's answer to one call, by the link it came over. */
type Machine = (call: Call, profile: Profile) => unknown;

const completed = {
  transferId: "transfer-lost",
  state: "completed",
  method: "bundle",
  offset: 0,
  result: { workspaceId: "w-there", path: "/srv/app", threadId: "t-there" },
};
const importing = { transferId: "transfer-lost", state: "importing", method: "bundle", offset: 0 };
const notFound = () => {
  throw new MachineFailure("refused", "not_found", "This machine has no such transfer.");
};

/**
 * A transfer of thread t-1 to Studio (host `studio`) that sent its commit, started under the
 * pairing whose device is `dev-1`. `live`: a working thread handed over, waiting for Studio.
 */
async function lostAnswer(options: { live: boolean; committed?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "ace-outgoing-relink-"));
  const directory = join(root, "outgoing");
  await mkdir(directory, { recursive: true });
  const store = new Store(join(root, "store.sqlite"));
  const rows = new OutgoingRows(store);
  const ownership = new ThreadOwnership(store);
  const transferId = "transfer-lost";
  const transfer: Transfer = {
    transferId,
    commandId: "c-lost" as CommandId,
    kind: "thread",
    threadId: "t-1" as ThreadId,
    workspaceId: "w" as WorkspaceId,
    target: { hostId: "studio" as HostId, name: "Studio" },
    phase: "importing",
    method: "bundle",
    sentBytes: 5,
    totalBytes: 5,
    ...(options.live ? { live: { stage: "handing" as const } } : {}),
    startedAt: 0,
    updatedAt: 0,
  };
  rows.insert({
    transfer,
    request: {
      hostId: "studio" as HostId,
      profile: "studio",
      deviceId: "dev-1",
      includeChanges: true,
      includeIgnored: false,
      live: options.live,
    },
    plan: {
      source: root,
      name: "app",
      ...(options.committed === false ? {} : { committed: true as const }),
      ...(options.live ? { interrupted: true } : {}),
    },
    delivered: true,
  });
  if (options.live) {
    ownership.change("t-1", {
      to: "stopping",
      transferId,
      peer: { hostId: "studio", name: "Studio" },
      at: 0,
    });
    ownership.change("t-1", { to: "handing", transferId, at: 0 });
  }
  /** What the thread shows and is told: its "Moving to" row, moves and resumes. */
  const thread: string[] = [];
  const live = new LiveSource({
    ownership,
    hold: (_thread, _transfer, change) =>
      thread.push("title" in change ? `hold: ${change.title}` : "hold ended"),
    moved: (_thread, to) => thread.push(`moved to ${to.name}`),
    released: () => thread.push("released"),
    resume: (_thread, _transfer, text) => thread.push(`told: ${text}`),
    atomic: (run) => store.atomic(run),
    now: () => 0,
  } as unknown as LiveSourcePorts);
  const machines: Record<string, Machine> = {};
  /** Every call that left, as `<host the link names>:<op>`. */
  const asked: string[] = [];
  const state = { profiles: [] as Profile[] };
  const outgoing = new OutgoingTransfers({
    store,
    directory,
    profiles: () => state.profiles,
    transport: (profile: Profile, route: { body: Buffer | string }) => {
      const call = JSON.parse(String(route.body)) as Call;
      const host = profile.hostId ?? profile.name;
      if (call.op !== "probe") asked.push(`${host}:${call.op}`);
      const machine = machines[`${profile.id}`];
      if (!machine) return Promise.reject(new MachineFailure("offline"));
      try {
        return Promise.resolve(machine(call, profile));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    origin: async () => ({ hostId: "macbook" as HostId, hostName: "MacBook" }),
    git: { deleteRef: async () => {} },
    threads: {
      continuedOn: (_id: ThreadId, on: { name: string }) => thread.push(`continued on ${on.name}`),
    },
    live,
    now: () => 0,
    sleep: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    nextId: () => "id",
    log: () => {},
  } as unknown as OutgoingDeps);
  const settled: Transfer[] = [];
  outgoing.onSettled((record) => settled.push(record.transfer));
  cleanups.push(async () => {
    await Promise.race([outgoing.close(), new Promise((resolve) => setTimeout(resolve, 50))]);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    outgoing,
    state,
    machines,
    asked,
    thread,
    settled,
    ownership: () => ownership.get("t-1"),
    phase: () => outgoing.get(transferId)?.transfer,
  };
}

it("never sends a transfer to another machine under its target's old name, and finishes once that machine is back", async () => {
  const t = await lostAnswer({ live: true });
  // Studio was unlinked; another machine took the free name, and an old link with no host id
  // kept says it is yet another one.
  t.state.profiles = [
    { id: "p-mini", name: "studio", hostId: "mini", deviceId: "d-mini" },
    { id: "p-laptop", name: "laptop", deviceId: "d-laptop" },
  ];
  t.machines["p-mini"] = () => importing;
  t.machines["p-laptop"] = (call) =>
    call.op === "probe" ? { hostId: "laptop", name: "Laptop", accepts: true } : importing;
  await t.outgoing.recover();
  // Said on the thread in plain words, and on the transfer for the strip's actions.
  await expect.poll(() => t.phase()?.unlinked).toBe(true);
  expect(t.thread).toContain("hold: Moving to Studio, which isn't linked any more");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(t.asked).toEqual([]);
  expect(t.phase()?.phase).toBe("importing");
  // Studio linked again, under any name: the move finishes there, the thread reads moved and
  // its hold ends.
  t.state.profiles = [
    ...t.state.profiles,
    { id: "p-studio", name: "studio-2", hostId: "studio", deviceId: "dev-2" },
  ];
  t.machines["p-studio"] = () => completed;
  await expect.poll(() => t.phase()?.phase).toBe("completed");
  expect(t.phase()?.unlinked).toBeUndefined();
  expect(t.thread).toContain("hold: Moving to Studio");
  expect(t.thread).toContain("moved to Studio");
  expect(t.thread).toContain("hold ended");
  expect(t.ownership()?.state).toBe("moved");
  expect(t.settled.map((transfer) => transfer.phase)).toEqual(["completed"]);
  expect(t.asked.filter((call) => !call.startsWith("studio:"))).toEqual([]);
});

it("a handed-over move asks under the new pairing once its machine was linked again mid-wait", async () => {
  const t = await lostAnswer({ live: true });
  // The old pairing no longer answers: Studio was paired again, with a new device here.
  t.state.profiles = [{ id: "p-old", name: "studio", hostId: "studio", deviceId: "dev-1" }];
  await t.outgoing.recover();
  await expect.poll(() => t.asked.length).toBeGreaterThan(1);
  t.state.profiles = [{ id: "p-new", name: "studio", hostId: "studio", deviceId: "dev-2" }];
  t.machines["p-new"] = () => completed;
  await expect.poll(() => t.phase()?.phase).toBe("completed");
  expect(t.thread).toContain("moved to Studio");
  expect(t.thread).toContain("hold ended");
});

it("a cancel never takes 'no such transfer' for a cancel once the commit may have landed", async () => {
  const t = await lostAnswer({ live: false });
  t.state.profiles = [{ id: "p-studio", name: "studio", hostId: "studio", deviceId: "dev-1" }];
  // The commit landed and its answer was lost; a rows lookup there now finds none (as a
  // re-paired device's would): the work may well be there.
  t.machines["p-studio"] = (call) => (call.op === "cancel" ? notFound() : importing);
  await expect(t.outgoing.cancel("transfer-lost")).rejects.toMatchObject({
    code: "cancel_unconfirmed",
  });
  expect(t.phase()?.phase).not.toBe("cancelled");
  expect(t.settled).toEqual([]);
});

it("a cancel asked under a new pairing never takes 'no such transfer' for a cancel", async () => {
  const t = await lostAnswer({ live: false, committed: false });
  // Paired again: the device here is new, and the target's rows were made by the old one.
  t.state.profiles = [{ id: "p-studio", name: "studio", hostId: "studio", deviceId: "dev-2" }];
  t.machines["p-studio"] = (call) => (call.op === "cancel" ? notFound() : importing);
  await expect(t.outgoing.cancel("transfer-lost")).rejects.toMatchObject({
    code: "cancel_unconfirmed",
  });
  expect(t.settled).toEqual([]);
});

it("a cancel before the commit, under the pairing it started with, settles on 'no such transfer'", async () => {
  const t = await lostAnswer({ live: false, committed: false });
  t.state.profiles = [{ id: "p-studio", name: "studio", hostId: "studio", deviceId: "dev-1" }];
  t.machines["p-studio"] = (call) => (call.op === "cancel" ? notFound() : importing);
  await expect(t.outgoing.cancel("transfer-lost")).resolves.toMatchObject({ phase: "cancelled" });
});

it("carries a moving thread on here only by the person's choice while its machine isn't linked", async () => {
  const t = await lostAnswer({ live: true });
  t.state.profiles = [{ id: "p-studio", name: "studio", hostId: "studio", deviceId: "dev-1" }];
  t.machines["p-studio"] = () => importing;
  // Linked: only Studio's answer settles the move.
  await expect(t.outgoing.carryOnHere("transfer-lost")).rejects.toMatchObject({
    code: "machine_linked",
  });
  t.state.profiles = [];
  await t.outgoing.recover();
  await expect.poll(() => t.phase()?.unlinked).toBe(true);
  const carried = await t.outgoing.carryOnHere("transfer-lost");
  // Recorded on the transfer, with the warning; the thread is this machine's again, its hold
  // ended, and the stopped agent told to carry on.
  expect(carried).toMatchObject({
    phase: "cancelled",
    error: { code: "carried_on_here", message: expect.stringContaining("both may run") },
  });
  expect(t.ownership()).toBeUndefined();
  expect(t.thread).toContain("hold ended");
  expect(t.thread).toContain("released");
  expect(t.thread.some((line) => line.startsWith("told: "))).toBe(true);
  expect(t.settled.map((transfer) => transfer.phase)).toEqual(["cancelled"]);
});
