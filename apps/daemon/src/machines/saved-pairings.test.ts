import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeviceId, DeviceToken } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Profiles } from "../cli/profiles.ts";
import { SAVED_PAIRINGS_RETRY_MS, SavedPairings } from "./saved-pairings.ts";

const homes: string[] = [];
const open: SavedPairings[] = [];
afterEach(() => {
  for (const saved of open.splice(0)) saved.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-saved-pairings-"));
  homes.push(home);
  const logs: string[] = [];
  const clock = { now: 0 };
  const saved = new SavedPairings(home, (message) => logs.push(message), () => clock.now);
  open.push(saved);
  /** Changes made through another connection, as Settings or the `ace remote` CLI do. */
  const elsewhere = (change: (table: Profiles) => void) => {
    const table = new Profiles(home);
    try {
      change(table);
    } finally {
      table.close();
    }
  };
  const add = (name: string, token: string) =>
    elsewhere((table) =>
      table.add({
        name,
        origin: "https://127.0.0.1:4433/",
        fingerprint: "a".repeat(64),
        deviceId: DeviceId.parse(`device-${name}`),
        token: DeviceToken.parse(token.repeat(64)),
      }),
    );
  return { home, saved, add, elsewhere, logs, clock, file: join(home, "cli-profiles.sqlite") };
}

test("a pairing added or removed by another process is seen on the next look", () => {
  const h = setup();
  expect(h.saved.list()).toEqual([]);
  h.add("studio", "a");
  expect(h.saved.list()?.map((profile) => profile.name)).toEqual(["studio"]);
  h.elsewhere((table) => table.remove("studio"));
  expect(h.saved.keys()?.size).toBe(0);
});

test("while nothing changes the pairings are not read again", () => {
  const h = setup();
  h.add("studio", "a");
  const first = h.saved.keys();
  for (let i = 0; i < 5; i++) expect(h.saved.keys()).toBe(first);
  h.add("laptop", "b");
  expect(h.saved.keys()).not.toBe(first);
  expect(h.saved.keys()?.size).toBe(2);
});

test("a missing file means no pairings, and a file put in its place is read afresh", () => {
  const h = setup();
  h.add("studio", "a");
  expect(h.saved.keys()?.size).toBe(1);
  rmSync(h.file);
  expect(h.saved.keys()?.size).toBe(0);
  // Another file with a different pairing is moved into place.
  const other = mkdtempSync(join(tmpdir(), "ace-saved-other-"));
  homes.push(other);
  const table = new Profiles(other);
  table.add({
    name: "laptop",
    origin: "https://127.0.0.1:4434/",
    fingerprint: "b".repeat(64),
    deviceId: DeviceId.parse("device-laptop"),
    token: DeviceToken.parse("c".repeat(64)),
  });
  table.close();
  renameSync(join(other, "cli-profiles.sqlite"), h.file);
  expect(h.saved.list()?.map((profile) => profile.name)).toEqual(["laptop"]);
});

test("a file another writer holds reads as unreadable, logged once, and is read once released", () => {
  const h = setup();
  h.add("studio", "a");
  expect(h.saved.keys()?.size).toBe(1);
  h.add("laptop", "b");
  const writer = new DatabaseSync(h.file);
  writer.exec("BEGIN EXCLUSIVE");
  try {
    expect(h.saved.keys()).toBeUndefined();
    expect(h.saved.keys()).toBeUndefined();
  } finally {
    writer.exec("COMMIT");
    writer.close();
  }
  // Looks in the window after a failure answer at once, without touching the file.
  expect(h.saved.keys()).toBeUndefined();
  h.clock.now += SAVED_PAIRINGS_RETRY_MS;
  expect(h.saved.keys()?.size).toBe(2);
  expect(h.logs).toEqual([
    "Saved pairings can't be read; calls to paired machines wait",
    "Saved pairings can be read again",
  ]);
});
