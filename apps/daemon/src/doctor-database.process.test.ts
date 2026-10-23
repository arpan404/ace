import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDaemonHome } from "@ace/service/home";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { expect, it } from "vitest";
import { startDaemon, readConfig, AdapterRegistry } from "./index.ts";
import { DeviceId, DeviceToken } from "@ace/protocol";
import { Profiles } from "./cli/profiles.ts";
import { invoke } from "./cli-test-support.ts";

it("doctor finds space retained after deletion and fix reclaims it without changing surviving row IDs", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-doctor-database-"));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: { doctor: async () => ({ at: 1, checks: [] }), toolchains: async () => [] },
  });
  try {
    daemon.store.atomic(() => {
      daemon.store.statement("CREATE TABLE doctor_probe(value TEXT)").run();
      const insert = daemon.store.statement("INSERT INTO doctor_probe VALUES (?)");
      for (let i = 0; i < 512; i++) insert.run("retained-" + i + "x".repeat(8192));
      daemon.store.statement("DELETE FROM doctor_probe WHERE rowid < 512").run();
    });
    const path = join(home, "events.sqlite");
    const env = { PATH: "/usr/bin:/bin" };
    const before = JSON.parse((await invoke(home, ["doctor", "--json"], "", env)).stdout);
    expect(before.checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.space", status: "warn" }),
    );
    const bytes = (await stat(path)).size + (await stat(path + "-wal")).size;
    // Doctor must target the inspected local database even with a selected remote.
    const profiles = new Profiles(home);
    try {
      profiles.add({
        name: "unreachable",
        origin: "https://127.0.0.1:1/",
        fingerprint: "a".repeat(64),
        deviceId: DeviceId.parse("doctor-test"),
        token: DeviceToken.parse("b".repeat(64)),
      });
      profiles.use("unreachable");
    } finally {
      profiles.close();
    }

    const fixed = JSON.parse((await invoke(home, ["doctor", "--fix", "--json"], "", env)).stdout);
    expect(fixed.repairs).toContainEqual(
      expect.objectContaining({ id: "sqlite.space", status: "fixed" }),
    );
    expect(fixed.checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.space", status: "ok" }),
    );
    expect((await stat(path)).size + (await stat(path + "-wal")).size).toBeLessThan(
      bytes - 2 * 1024 * 1024,
    );
    expect(daemon.store.statement("SELECT rowid, value FROM doctor_probe").all()).toEqual([
      { rowid: 512, value: "retained-511" + "x".repeat(8192) },
    ]);
    expect(daemon.store.statement("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("doctor leaves a legacy database's reusable pages and surviving row IDs intact", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-doctor-legacy-"));
  const path = join(home, "events.sqlite");
  prepareDaemonHome(home);
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA auto_vacuum=NONE; CREATE TABLE legacy_marker(value TEXT)");
  legacy.close();
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: { doctor: async () => ({ at: 1, checks: [] }), toolchains: async () => [] },
  });
  try {
    daemon.store.atomic(() => {
      daemon.store.statement("CREATE TABLE doctor_probe(value TEXT)").run();
      const insert = daemon.store.statement("INSERT INTO doctor_probe VALUES (?)");
      for (let i = 0; i < 512; i++) insert.run("x".repeat(8192));
      daemon.store.statement("DELETE FROM doctor_probe WHERE rowid < 512").run();
    });
    const before = daemon.store.statement("PRAGMA freelist_count").get();
    const fixed = JSON.parse(
      (await invoke(home, ["doctor", "--fix", "--json"], "", { PATH: "/usr/bin:/bin" })).stdout,
    );
    expect(fixed.repairs).toContainEqual(
      expect.objectContaining({
        id: "sqlite.space",
        status: "skipped",
        message: expect.stringContaining("No full VACUUM"),
      }),
    );
    expect(fixed.checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.space", status: "warn" }),
    );
    expect(daemon.store.statement("SELECT rowid, value FROM doctor_probe").all()).toEqual([
      { rowid: 512, value: "x".repeat(8192) },
    ]);
    expect(daemon.store.statement("PRAGMA auto_vacuum").get()).toMatchObject({ auto_vacuum: 0 });
    expect(daemon.store.statement("PRAGMA freelist_count").get()).toEqual(before);
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("doctor does not write an offline database when reclamation needs its storage owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-doctor-offline-"));
  const path = join(home, "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE payload(value TEXT)");
  const insert = db.prepare("INSERT INTO payload VALUES (?)");
  for (let i = 0; i < 256; i++) insert.run("x".repeat(8192));
  db.exec("DELETE FROM payload");
  db.close();
  const before = await readFile(path);
  try {
    const fixed = JSON.parse(
      (await invoke(home, ["doctor", "--fix", "--json"], "", { PATH: "/usr/bin:/bin" })).stdout,
    );
    expect(fixed.repairs).toContainEqual(
      expect.objectContaining({
        id: "sqlite.space",
        status: "skipped",
        message: expect.stringContaining("No offline database writes"),
      }),
    );
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("doctor fix preserves a corrupt database and reports a failure instead of rebuilding it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-doctor-corrupt-"));
  const path = join(home, "events.sqlite");
  const before = Buffer.from("SQLite format 3\0" + "damaged".repeat(1024));
  await writeFile(path, before);
  try {
    const result = await invoke(home, ["doctor", "--fix", "--json"], "", { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "sqlite", status: "fail" }));
    expect(report.repairs.some((repair: { id: string }) => repair.id === "sqlite.space")).toBe(
      false,
    );
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("doctor keeps a reader-pinned WAL and can reclaim it after the reader finishes", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-doctor-reader-"));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: { doctor: async () => ({ at: 1, checks: [] }), toolchains: async () => [] },
  });
  let reader: DatabaseSync | undefined;
  try {
    daemon.store.statement("CREATE TABLE doctor_wal(value TEXT)").run();
    daemon.store.statement("INSERT INTO doctor_wal VALUES ('snapshot')").run();
    daemon.store.statement("PRAGMA wal_checkpoint(TRUNCATE)").all();
    daemon.store.statement("PRAGMA wal_autocheckpoint=0").all();
    reader = new DatabaseSync(join(home, "events.sqlite"), { readOnly: true });
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT value FROM doctor_wal").get()?.value).toBe("snapshot");
    daemon.store.atomic(() => {
      const insert = daemon.store.statement("INSERT INTO doctor_wal VALUES (?)");
      for (let i = 0; i < 4200; i++) insert.run("x".repeat(8192));
    });
    const wal = join(home, "events.sqlite-wal");
    expect((await stat(wal)).size).toBeGreaterThan(32 * 1024 * 1024);
    const env = { PATH: "/usr/bin:/bin" };
    const blocked = JSON.parse((await invoke(home, ["doctor", "--fix", "--json"], "", env)).stdout);
    expect(blocked.repairs).toContainEqual(
      expect.objectContaining({
        id: "sqlite.space",
        status: "skipped",
        message: expect.stringContaining("reader"),
      }),
    );
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.wal", status: "warn" }),
    );
    expect(reader.prepare("SELECT count(*) AS count FROM doctor_wal").get()?.count).toBe(1);
    reader.close();
    reader = undefined;
    const resumed = JSON.parse((await invoke(home, ["doctor", "--fix", "--json"], "", env)).stdout);
    expect(resumed.repairs).toContainEqual(
      expect.objectContaining({ id: "sqlite.space", status: "fixed" }),
    );
    expect(resumed.checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.wal", status: "ok" }),
    );
    expect((await stat(wal)).size).toBeLessThan(1024 * 1024);
    expect(daemon.store.statement("SELECT count(*) AS count FROM doctor_wal").get()?.count).toBe(
      4201,
    );
  } finally {
    reader?.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
