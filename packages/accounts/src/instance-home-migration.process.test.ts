import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  access,
  stat,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect } from "vitest";
import { createInstance, initialQuota, openRegistryIndex } from "./index.ts";

async function seed(root: string, homeDir: string) {
  const dataDir = join(root, ".ace-next");
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "accounts.sqlite");
  const db = new DatabaseSync(path);
  const instance = createInstance({
    id: "cursor-sdk-default",
    label: "SDK",
    provider: "cursor",
    homeDir,
  });
  try {
    db.exec(
      "CREATE TABLE accounts(id TEXT PRIMARY KEY, instance TEXT NOT NULL, quota TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
      instance.id,
      JSON.stringify(instance),
      JSON.stringify(initialQuota()),
    );
  } finally {
    db.close();
  }
  return { path, dataDir, instance, target: join(dataDir, "instances", instance.id) };
}

test.each(["existing destination", "source symlink", "source rename denied"])(
  "%s preserves original data while the registry adopts a safe canonical home",
  async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-home-migration-")));
    const source = join(root, ".ace", "instances", "cursor-sdk-default");
    const cli = join(root, ".cursor");
    await mkdir(cli);
    await writeFile(join(cli, "user-data"), "untouched user state");
    const cliStat = await stat(cli);
    await mkdir(join(root, ".ace", "instances"), { recursive: true });
    if (scenario === "source symlink") await symlink(cli, source);
    else {
      await mkdir(source);
      await writeFile(join(source, "original-data"), "original state");
    }
    const f = await seed(root, source);
    if (scenario === "existing destination") {
      await mkdir(f.target, { recursive: true });
      await writeFile(join(f.target, "canonical-data"), "existing canonical state");
    }
    if (scenario === "source rename denied") await chmod(join(root, ".ace", "instances"), 0o500);
    const notices: unknown[] = [];
    const registry = await openRegistryIndex(f.path, undefined, f.dataDir, {
      notice: (notice) => notices.push(notice),
    });
    try {
      await registry.ready;
      expect(registry.get(f.instance.id)?.instance).toMatchObject({
        homeDir: f.target,
        env: { CURSOR_DATA_DIR: f.target },
      });
      expect(notices).toEqual([
        {
          instance: f.instance.id,
          outcome: "recreated",
          reason:
            scenario === "existing destination"
              ? "destination_exists"
              : scenario === "source symlink"
                ? "unsafe_source"
                : "move_refused",
        },
      ]);
      expect(await readFile(join(cli, "user-data"), "utf8")).toBe("untouched user state");
      expect(await stat(cli)).toMatchObject({ ino: cliStat.ino, mtimeMs: cliStat.mtimeMs });
      await access(source);
      if (scenario !== "source symlink")
        expect(await readFile(join(source, "original-data"), "utf8")).toBe("original state");
      if (scenario === "existing destination") {
        expect(await readFile(join(f.target, "canonical-data"), "utf8")).toBe(
          "existing canonical state",
        );
      }
    } finally {
      await registry.ready.catch(() => {});
      registry.close();
      await chmod(join(root, ".ace", "instances"), 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("restart repairs a row after an interrupted move without replacing the already moved directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-home-restart-")));
  const source = join(root, ".ace", "instances", "cursor-sdk-default");
  const f = await seed(root, source);
  await mkdir(f.target, { recursive: true });
  await writeFile(join(f.target, "history"), "preserved history");
  const before = await stat(f.target);
  const registry = await openRegistryIndex(f.path, undefined, f.dataDir, {});
  try {
    await registry.ready;
    expect(registry.get(f.instance.id)?.instance.homeDir).toBe(f.target);
    expect((await stat(f.target)).ino).toBe(before.ino);
    expect(await readFile(join(f.target, "history"), "utf8")).toBe("preserved history");
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["cursor", "codex", "claude"] as const)(
  "startup preserves a registered user %s CLI home and its selector",
  async (provider) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-user-home-")));
    const source = join(root, `.${provider}`);
    await mkdir(source);
    await writeFile(join(source, "user-data"), "user-owned");
    const f = await seed(root, source);
    // Give the historic row the provider and selector belonging to the real CLI home.
    const instance = createInstance({ ...f.instance, provider, homeDir: source });
    const db = new DatabaseSync(f.path);
    db.prepare("UPDATE accounts SET instance=?").run(JSON.stringify(instance));
    db.close();
    const registry = await openRegistryIndex(f.path, undefined, f.dataDir, {});
    try {
      await registry.ready;
      expect(registry.get(instance.id)?.instance).toMatchObject({
        homeDir: source,
        env: instance.env,
      });
      expect(await readFile(join(source, "user-data"), "utf8")).toBe("user-owned");
      await expect(access(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a canonical destination alias to a user CLI home refuses migration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-home-alias-")));
  const source = join(root, ".ace", "instances", "cursor-sdk-default");
  const cli = join(root, ".cursor");
  await mkdir(source, { recursive: true });
  await mkdir(cli);
  await writeFile(join(source, "original-data"), "original");
  await writeFile(join(cli, "user-data"), "untouched");
  const f = await seed(root, source);
  await mkdir(join(f.dataDir, "instances"));
  await symlink(cli, f.target);
  const registry = await openRegistryIndex(f.path, undefined, f.dataDir, {});
  try {
    await expect(registry.ready).rejects.toThrow("must not follow symbolic links");
    expect(await readFile(join(source, "original-data"), "utf8")).toBe("original");
    expect(await readFile(join(cli, "user-data"), "utf8")).toBe("untouched");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
