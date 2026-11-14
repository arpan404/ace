import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DeviceId, DeviceToken } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { SavedPairings } from "./saved-pairings.ts";

const homes: string[] = [];
const open: SavedPairings[] = [];
afterEach(() => {
  for (const saved of open.splice(0)) saved.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-saved-pairings-"));
  homes.push(home);
  const saved = new SavedPairings(home);
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
  return { saved, add, elsewhere };
}

test("a pairing added or removed by another process is seen on the next look", () => {
  const h = setup();
  expect(h.saved.list()).toEqual([]);
  h.add("studio", "a");
  expect(h.saved.list().map((profile) => profile.name)).toEqual(["studio"]);
  h.elsewhere((table) => table.remove("studio"));
  expect(h.saved.keys().size).toBe(0);
});

test("while nothing changes the pairings are not read again", () => {
  const h = setup();
  h.add("studio", "a");
  const first = h.saved.keys();
  for (let i = 0; i < 5; i++) expect(h.saved.keys()).toBe(first);
  h.add("laptop", "b");
  expect(h.saved.keys()).not.toBe(first);
  expect(h.saved.keys().size).toBe(2);
});
