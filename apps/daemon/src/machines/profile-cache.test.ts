import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeviceId, DeviceToken } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { cachedProfiles, fileStamp } from "./profile-cache.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Profiles in a temp home, read through the cache, counting the reads that open the file. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-profile-cache-"));
  homes.push(home);
  const clock = { now: 0 };
  let reads = 0;
  const path = join(home, "cli-profiles.sqlite");
  const profiles = cachedProfiles({
    stamp: () => fileStamp(path),
    read: () => {
      reads++;
      const table = new Profiles(home);
      try {
        return table.list();
      } finally {
        table.close();
      }
    },
    now: () => clock.now,
    maxAgeMs: 60_000,
  });
  const add = (name: string, token: string) => {
    const table = new Profiles(home);
    try {
      table.add({
        name,
        origin: "https://127.0.0.1:4433/",
        fingerprint: "a".repeat(64),
        deviceId: DeviceId.parse("device-1"),
        token: DeviceToken.parse(token.repeat(64)),
      });
    } finally {
      table.close();
    }
  };
  return { home, clock, profiles, add, reads: () => reads };
}

test("calls in a row read the paired machines once while nothing changes", () => {
  const h = setup();
  h.add("studio", "a");
  for (let i = 0; i < 10; i++) expect(h.profiles().map((p) => p.name)).toEqual(["studio"]);
  expect(h.reads()).toBe(1);
});

test("a machine paired from another process shows on the next call", () => {
  const h = setup();
  h.add("studio", "a");
  expect(h.profiles()).toHaveLength(1);
  h.add("laptop", "b");
  expect(h.profiles().map((p) => p.name)).toEqual(["laptop", "studio"]);
});

test("a removed machine is gone on the next call", () => {
  const h = setup();
  h.add("studio", "a");
  h.profiles();
  const table = new Profiles(h.home);
  table.remove("studio");
  table.close();
  expect(h.profiles()).toEqual([]);
});

test("the pairings are read again once the last read is old, even if the file looks the same", () => {
  const h = setup();
  h.add("studio", "a");
  h.profiles();
  h.clock.now += 60_000;
  h.profiles();
  expect(h.reads()).toBe(2);
});
