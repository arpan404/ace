import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostId, ThreadId } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { Store } from "../store.ts";
import { ParcelFiles } from "./files.ts";
import { ParcelLink } from "./link.ts";
import { ParcelPuller } from "./puller.ts";
import { ParcelRows, type InRow } from "./store.ts";

// ADR 0209 §4.2: a pull still receiving its last range when its machine is enrolled publishes
// nothing: no arrival reaches a thread on what is now an organization's host.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("a parcel whose last range arrives after enrollment never lands", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-pull-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const rows = new ParcelRows(store);
  const data = Buffer.from("the child's results");
  const parcelId = "pcl-00000000-0000-4000-8000-000000000001";
  const parent = ThreadId.parse("t_parent");
  const child = ThreadId.parse("t_child");
  const profile = RemoteProfile.parse({
    id: "7f0c1c55-4e3b-4f53-9a49-3a7c2b0d5e11",
    name: "studio",
    origin: "https://192.168.1.20:5870/",
    fingerprint: "a".repeat(64),
    deviceId: "source-device",
    token: "b".repeat(64),
  });
  let orgHost = false;
  const link = new ParcelLink({
    pinned: async (_target, route) => {
      const call = JSON.parse(String(route.body ?? "{}")).call.parcel;
      if (call.action === "outbox")
        return {
          outbox: [
            {
              from: child,
              to: parent,
              parcel: {
                parcelId,
                name: "results.txt",
                size: data.length,
                sha256: createHash("sha256").update(data).digest("hex"),
                fromTitle: "Child",
              },
            },
          ],
        };
      // Its last range is on its way when the machine is enrolled.
      orgHost = true;
      return { data: data.toString("base64"), offset: 0 };
    },
    relay: { call: () => Promise.reject(new Error("no relay")) },
    paths: () => [],
    hosted: () => false,
    current: () => true,
    orgHost: () => orgHost,
    now: () => 1,
  });
  const arrived: InRow[] = [];
  const puller = new ParcelPuller({
    rows,
    files: new ParcelFiles(home),
    link,
    profiles: () => [profile],
    machinesWithChildren: () => new Map([["studio", parent]]),
    remoteChild: () => ({ parentThread: parent, machine: "studio" }),
    live: () => true,
    origin: async (threadId) => ({
      hostId: HostId.parse("4b8f2a6e-1d3c-4e5f-8a7b-9c0d1e2f3a4b"),
      hostName: "MacBook",
      threadId: ThreadId.parse(threadId),
      threadTitle: "Parent",
      ceiling: "operate",
    }),
    arrived: (row) => arrived.push(row),
    room: () => 1024 ** 3,
    now: () => 1,
    pollMs: 10,
    log: () => {},
  });
  await puller.round(new AbortController().signal);
  expect(arrived).toEqual([]);
  expect(rows.in(parcelId)?.state).not.toBe("delivered");
  store.close();
});
