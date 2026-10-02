import { afterEach, expect, test } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { create } from "tar";
import {
  applyUpdate,
  atomicPointer,
  hashFile,
  MaintenanceGate,
  recoverUpdate,
  snapshotDatabases,
  restoreDatabases,
  type UpdatePorts,
  type UpdateRequest,
} from "./index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-update-"));
  roots.push(root);
  await mkdir(join(root, "releases/1.0.0-linux-x64"), { recursive: true });
  await writeFile(
    join(root, "releases/1.0.0-linux-x64/release.json"),
    JSON.stringify({ version: "1.0.0", channel: "stable", target: "linux-x64" }),
  );
  await writeFile(join(root, "releases/1.0.0-linux-x64/marker"), "old");
  await atomicPointer(join(root, "current"), "releases/1.0.0-linux-x64");
  const input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "marker"), "new");
  const archive = join(root, "candidate.tar.gz");
  await create({ cwd: input, file: archive, gzip: true }, ["marker"]);
  const payload = await readFile(archive);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    version: "1.1.0",
    target: "linux-x64",
    channel: "stable",
    archive: "ace-1.1.0-linux-x64.tar.gz",
    bytes: payload.length,
    sha256: await hashFile(archive),
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const db = new DatabaseSync(join(root, "events.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES('original')",
  );
  db.close();
  let running = true,
    blockers = 0,
    candidateHealthy = true,
    migrationFails = false,
    stops = 0;
  const gate = new MaintenanceGate(() => blockers);
  const ports: UpdatePorts = {
    now: () => 0,
    wait: async () => {
      blockers = 0;
    },
    maintenance: async (method) =>
      method === "POST" ? gate.enter() : method === "DELETE" ? gate.leave() : gate.status(),
    stop: async () => {
      running = false;
      stops++;
    },
    start: async () => {
      running = true;
    },
    health: async (version) => version === "1.0.0" || candidateHealthy,
    migrate: async (_candidate, copy) => {
      const check = new DatabaseSync(join(copy, "events.sqlite"));
      try {
        check.exec("ALTER TABLE data ADD COLUMN migrated TEXT");
      } finally {
        check.close();
      }
      if (migrationFails) throw new Error("bad migration");
    },
  };
  const request: UpdateRequest = {
    root,
    dataDir: root,
    bytes,
    signature: sign(null, bytes, privateKey).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    archiveUrl: "https://example.com/artifact",
    fetcher: async () => new Response(payload),
    ports,
    drain: false,
  };
  return {
    root,
    request,
    gate,
    get running() {
      return running;
    },
    get stops() {
      return stops;
    },
    block: () => {
      blockers = 1;
    },
    badHealth: () => {
      candidateHealthy = false;
    },
    badMigration: () => {
      migrationFails = true;
    },
    resign: (data: Buffer) => {
      request.bytes = data;
      request.signature = sign(null, data, privateKey).toString("base64");
    },
  };
}
test("a bad checksum never stops or swaps the installed daemon", { timeout: 60_000 }, async () => {
  const f = await fixture();
  const data = JSON.parse(Buffer.from(f.request.bytes).toString());
  data.sha256 = "0".repeat(64);
  f.resign(Buffer.from(JSON.stringify(data)));
  await expect(applyUpdate(f.request)).rejects.toThrow("checksum");
  expect(f.stops).toBe(0);
  expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("old");
});
test(
  "a bad signature never downloads or changes the installation",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    f.request.signature = Buffer.alloc(64).toString("base64");
    f.request.fetcher = async () => {
      throw new Error("download must not run");
    };
    await expect(applyUpdate(f.request)).rejects.toThrow("signature");
    expect(f.stops).toBe(0);
    expect(await readlink(join(f.root, "current"))).toBe("releases/1.0.0-linux-x64");
  },
);
test(
  "healthy updates atomically expose the candidate and retain the previous version",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    expect(await applyUpdate(f.request)).toBe("updated");
    expect(f.running).toBe(true);
    expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("new");
    expect(await readFile(join(f.root, "previous/marker"), "utf8")).toBe("old");
    expect(f.gate.admit()).toBe(true);
  },
);
test(
  "failed candidate health restores the old executable and database schema",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    f.badHealth();
    f.request.ports.start = async () => {
      const target = await readlink(join(f.root, "current"));
      if (target.includes("1.1.0")) {
        const db = new DatabaseSync(join(f.root, "events.sqlite"));
        db.exec("ALTER TABLE data ADD COLUMN incompatible TEXT; UPDATE data SET value='changed'");
        db.close();
      }
    };
    await expect(applyUpdate(f.request)).rejects.toThrow("health");
    expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("old");
    const db = new DatabaseSync(join(f.root, "events.sqlite"));
    expect(db.prepare("SELECT value FROM data").get()?.value).toBe("original");
    expect(db.prepare("PRAGMA table_info(data)").all()).toHaveLength(1);
    db.close();
  },
);
test(
  "active trees block restart and release admission when drain was not approved",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    f.block();
    await expect(applyUpdate(f.request)).rejects.toThrow("Active threads");
    expect(f.stops).toBe(0);
    expect(f.gate.admit()).toBe(true);
    expect(await readlink(join(f.root, "current"))).toBe("releases/1.0.0-linux-x64");
  },
);
test(
  "approved drain closes admission and waits for natural completion before stopping",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    f.block();
    f.request.drain = true;
    const wait = f.request.ports.wait;
    f.request.ports.wait = async () => {
      expect(f.gate.admit()).toBe(false);
      expect(f.stops).toBe(0);
      await wait();
    };
    await applyUpdate(f.request);
    expect(f.stops).toBe(1);
  },
);
test(
  "a failed migration on a copy blocks the swap and preserves live data",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    f.badMigration();
    await expect(applyUpdate(f.request)).rejects.toThrow("bad migration");
    expect(f.running).toBe(true);
    expect(await readlink(join(f.root, "current"))).toBe("releases/1.0.0-linux-x64");
    const db = new DatabaseSync(join(f.root, "events.sqlite"));
    expect(db.prepare("PRAGMA table_info(data)").all()).toHaveLength(1);
    expect(db.prepare("SELECT value FROM data").get()?.value).toBe("original");
    db.close();
  },
);
test(
  "readers see either complete pointer while swaps race with reads",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    await mkdir(join(f.root, "releases/other"));
    await writeFile(join(f.root, "releases/other/marker"), "other");
    const results = await Promise.allSettled([
      (async () => {
        for (let i = 0; i < 100; i++)
          await atomicPointer(
            join(f.root, "current"),
            i % 2 ? "releases/other" : "releases/1.0.0-linux-x64",
          );
      })(),
      (async () => {
        for (let i = 0; i < 200; i++)
          expect(["old", "other"]).toContain(
            await readFile(join(f.root, await readlink(join(f.root, "current")), "marker"), "utf8"),
          );
      })(),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  },
);
test("SQLite snapshots contain uncheckpointed WAL changes", { timeout: 60_000 }, async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.root, "events.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO data VALUES('wal-only')",
  );
  await snapshotDatabases(f.root, join(f.root, "snapshot"));
  const copy = new DatabaseSync(join(f.root, "snapshot/events.sqlite"));
  expect(
    copy
      .prepare("SELECT value FROM data ORDER BY rowid")
      .all()
      .map((r) => r.value),
  ).toEqual(["original", "wal-only"]);
  copy.close();
  db.close();
});
test(
  "interrupted swaps recover the old pointer and pre-migration data before another update",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    await snapshotDatabases(f.root, join(f.root, ".rollback-db"));
    await mkdir(join(f.root, "releases/1.1.0-linux-x64"));
    await atomicPointer(join(f.root, "current"), "releases/1.1.0-linux-x64");
    await writeFile(
      join(f.root, "update.json"),
      JSON.stringify({
        old: "releases/1.0.0-linux-x64",
        candidate: "releases/1.1.0-linux-x64",
        version: "1.0.0",
        stage: "snapshotted",
        databases: ["events.sqlite"],
      }),
    );
    const db = new DatabaseSync(join(f.root, "events.sqlite"));
    db.exec("UPDATE data SET value='candidate'");
    db.close();
    expect(await recoverUpdate(f.root, f.root, f.request.ports)).toBe(true);
    expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("old");
    const old = new DatabaseSync(join(f.root, "events.sqlite"));
    expect(old.prepare("SELECT value FROM data").get()?.value).toBe("original");
    old.close();
  },
);
test("an unsafe recovery target is rejected before stopping or removing installation data", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "update.json"),
    JSON.stringify({
      old: "releases/1.0.0-linux-x64",
      candidate: "releases/..",
      version: "1.0.0",
      stage: "prepared",
    }),
  );
  await expect(recoverUpdate(f.root, f.root, f.request.ports)).rejects.toThrow();
  expect(f.running).toBe(true);
  expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("old");
});
test("an interrupted snapshot restarts the old generation without overwriting live data", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".rollback-db"));
  await writeFile(join(f.root, ".rollback-db/events.sqlite"), "incomplete snapshot");
  await writeFile(
    join(f.root, "update.json"),
    JSON.stringify({
      old: "releases/1.0.0-linux-x64",
      candidate: "releases/1.1.0-linux-x64",
      version: "1.0.0",
      stage: "prepared",
    }),
  );
  await f.request.ports.stop();
  await recoverUpdate(f.root, f.root, f.request.ports);
  expect(f.running).toBe(true);
  expect(await readlink(join(f.root, "current"))).toBe("releases/1.0.0-linux-x64");
  const db = new DatabaseSync(join(f.root, "events.sqlite"));
  try {
    expect(db.prepare("SELECT value FROM data").get()?.value).toBe("original");
  } finally {
    db.close();
  }
  await expect(readFile(join(f.root, "update.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("missing or corrupt rollback snapshots never delete live databases", async () => {
  const f = await fixture();
  const missing = join(f.root, "missing-snapshot");
  await expect(restoreDatabases(f.root, missing, ["events.sqlite"])).rejects.toThrow();
  await mkdir(missing);
  await writeFile(join(missing, "events.sqlite"), "corrupt");
  await expect(restoreDatabases(f.root, missing, ["events.sqlite"])).rejects.toThrow();
  const db = new DatabaseSync(join(f.root, "events.sqlite"));
  try {
    expect(db.prepare("SELECT value FROM data").get()?.value).toBe("original");
  } finally {
    db.close();
  }
});
test("a failed stop leaves recoverable intent and restarts the unchanged generation", async () => {
  const f = await fixture();
  const stop = f.request.ports.stop;
  let fail = true;
  f.request.ports.stop = async () => {
    await stop();
    if (fail) {
      fail = false;
      expect(JSON.parse(await readFile(join(f.root, "update.json"), "utf8"))).toMatchObject({
        stage: "prepared",
      });
      throw new Error("stop acknowledgement lost");
    }
  };
  await expect(applyUpdate(f.request)).rejects.toThrow("stop acknowledgement lost");
  expect(f.running).toBe(true);
  expect(await readFile(join(f.root, "current/marker"), "utf8")).toBe("old");
  expect(f.gate.admit()).toBe(true);
});

test("an approved drain deadline refuses restart and reopens admission while work remains active", async () => {
  const f = await fixture();
  f.block();
  f.request.drain = true;
  let now = 0;
  f.request.ports.now = () => now;
  f.request.ports.wait = async () => {
    now = 300_001;
  };
  await expect(applyUpdate(f.request)).rejects.toThrow("Active threads");
  expect(f.stops).toBe(0);
  expect(f.gate.admit()).toBe(true);
  expect(await readlink(join(f.root, "current"))).toBe("releases/1.0.0-linux-x64");
});
