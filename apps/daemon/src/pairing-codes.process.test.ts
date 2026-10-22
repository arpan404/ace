import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Devices } from "./devices.ts";
import { migrate } from "./migrations.ts";
import { SqlitePairingCodes } from "./pairing-codes.ts";
import { RemoteAuth } from "./remote-auth.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One daemon home; each `start` is a new daemon process over the same database file. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "ace-pairing-codes-"));
  const path = join(dir, "events.sqlite");
  const open: DatabaseSync[] = [];
  cleanups.push(() => {
    for (const db of open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  let secrets = 0;
  return {
    path,
    advance(ms: number) {
      clock += ms;
    },
    start() {
      for (const db of open.splice(0)) db.close();
      const db = new DatabaseSync(path);
      open.push(db);
      migrate(db);
      const devices = new Devices(db, {
        id: randomUUID,
        randomBytes: (size) => Buffer.alloc(size, 7),
      });
      const auth = new RemoteAuth(
        devices,
        "a".repeat(64),
        { now: () => clock, secret: () => `${++secrets}`.padStart(64, "0"), id: randomUUID },
        undefined,
        new SqlitePairingCodes(db),
      );
      return { auth, db };
    },
  };
}

test("a pairing link issued before a restart still pairs once afterwards", () => {
  const daemon = home();
  const { code, id } = daemon.start().auth.pairing(["read", "operate"], { label: "Phone" });
  const restarted = daemon.start().auth;
  expect(restarted.pendingPairings().map((pending) => pending.id)).toEqual([id]);
  const paired = restarted.redeem(code, "ignored");
  expect(paired.device).toMatchObject({ name: "Phone", scopes: ["read", "operate"] });
  // Single use, across restarts too.
  expect(() => daemon.start().auth.redeem(code, "Second")).toThrow("Invalid or expired");
});

test("a link still ends at its own expiry across a restart", () => {
  const daemon = home();
  const { code } = daemon.start().auth.pairing(["read"], { ttlMs: 60_000 });
  daemon.advance(60_000);
  const restarted = daemon.start().auth;
  expect(restarted.pendingPairings()).toEqual([]);
  expect(() => restarted.redeem(code, "Phone")).toThrow("Invalid or expired");
});

test("the database holds only the code's hash, and a cancelled link pairs nothing", () => {
  const daemon = home();
  const { auth, db } = daemon.start();
  const kept = auth.pairing(["read"]);
  const cancelled = auth.pairing(["read"]);
  const stored = JSON.stringify(db.prepare("SELECT * FROM pairing_codes").all());
  expect(stored).not.toContain(kept.code);
  expect(auth.cancelPairing(cancelled.id)).toBe(true);
  const restarted = daemon.start().auth;
  expect(() => restarted.redeem(cancelled.code, "Phone")).toThrow("Invalid or expired");
  expect(restarted.redeem(kept.code, "Phone").device.scopes).toEqual(["read"]);
});
