import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MachineDirectory } from "@ace/client/machines";
import { paired, persistence } from "./machines-process.fixture.ts";

test("a persisted directory survives restart without credentials and a failed removal never restores deleted authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-machine-directory-"));
  try {
    const file = join(root, "machines.json");
    const f = persistence();
    const storage = {
      load: async () => readFile(file, "utf8"),
      save: async (raw: string) => {
        await writeFile(file, raw, { mode: 0o600 });
      },
    };
    await storage.save(JSON.stringify({ version: 1, machines: [] }));
    const directory = new MachineDirectory(storage, f.secrets);
    await directory.load();
    await directory.add(paired("laptop"));
    await directory.rename("laptop", "Personal");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("Personal");
    expect(raw).not.toContain("a".repeat(64));
    expect(raw).not.toContain('"token"');
    const restored = new MachineDirectory(storage, f.secrets);
    const [entry] = await restored.load();
    if (!entry) throw new Error("Missing restored machine");
    expect(await restored.token(entry)).toBe("a".repeat(64));
    const save = storage.save;
    storage.save = async () => {
      throw new Error("Disk unavailable");
    };
    await expect(restored.remove("laptop")).rejects.toThrow("Disk unavailable");
    expect(f.tokens.size).toBe(0);
    expect(await readFile(file, "utf8")).toBe(raw);
    const restarted = new MachineDirectory(storage, f.secrets);
    expect(await restarted.load()).toEqual([entry]);
    await expect(restarted.token(entry)).rejects.toMatchObject({ code: "auth" });
    storage.save = save;
    await restarted.remove("laptop");
    const empty = new MachineDirectory(storage, f.secrets);
    expect(await empty.load()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "not-json",
  "x".repeat(1024 * 1024 + 1),
  JSON.stringify({
    version: 1,
    machines: [
      {
        hostId: "host",
        displayName: "host",
        deviceId: "device",
        target: { kind: "direct", url: "ws://host/" },
        token: "a".repeat(64),
      },
    ],
  }),
  JSON.stringify({
    version: 1,
    machines: Array.from({ length: 2 }, () => ({
      hostId: "host",
      displayName: "host",
      deviceId: "device",
      target: { kind: "direct", url: "ws://host/" },
    })),
  }),
])(
  "invalid persisted directories reject before exposing any machine entries: case %#",
  async (raw) => {
    const f = persistence();
    await f.storage.save(raw);
    await expect(f.directory.load()).rejects.toThrow();
    expect(f.directory.machines).toEqual([]);
    expect(f.tokens.size).toBe(0);
  },
);

test.each([
  "ws://user:password@host/",
  "wss://host/?token=secret",
  "https://host/#token=secret",
  "file:///tmp/daemon",
])("credential-bearing or unsupported targets cannot create authorization: %s", async (url) => {
  const f = persistence();
  await f.directory.load();
  await expect(
    f.directory.add({ ...paired("host"), target: { kind: "direct", url } }),
  ).rejects.toThrow();
  expect(f.tokens.size).toBe(0);
  expect(f.directory.machines).toEqual([]);
  expect(f.raw()).toBeNull();
});

test("failed pairing metadata persistence rolls back the new secret without changing existing machines", async () => {
  const f = persistence();
  await f.directory.load();
  await f.directory.add(paired("existing"));
  const raw = f.raw();
  f.storage.save = async () => {
    throw new Error("Disk unavailable");
  };
  await expect(f.directory.add(paired("new"))).rejects.toThrow("Disk unavailable");
  expect(f.tokens.size).toBe(1);
  expect(f.directory.machines.map((entry) => entry.hostId)).toEqual(["existing"]);
  expect(f.raw()).toBe(raw);
});
