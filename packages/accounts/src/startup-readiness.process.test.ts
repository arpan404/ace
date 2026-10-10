import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderInstance } from "@ace/protocol/accounts";
import { createInstance, initialQuota, openRegistryIndex } from "./index.ts";

test("opening the account index admits no assignments before saved homes are canonicalized", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-account-ready-"));
  const home = join(root, "provider");
  await mkdir(home);
  const path = join(root, "accounts.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,instance TEXT NOT NULL,quota TEXT NOT NULL)");
  const instance = createInstance({
    id: "account",
    provider: "claude",
    label: "test",
    homeDir: home,
  });
  db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
    instance.id,
    JSON.stringify(instance),
    JSON.stringify({ ...initialQuota(), auth: "logged_in" }),
  );
  db.close();
  const registry = await openRegistryIndex(path);
  try {
    expect(() =>
      registry.pickInstance({ provider: "claude", role: "worker", estimatedLoad: 1 }, 0),
    ).toThrow("still being validated");
    await registry.ready;
    expect(registry.get("account")?.instance.homeDir).toBe(await realpath(home));
    expect(
      registry.pickInstance({ provider: "claude", role: "worker", estimatedLoad: 1 }, 0)?.id,
    ).toBe("account");
  } finally {
    await registry.ready.catch(() => undefined);
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted managed account cannot prevent healthy accounts from loading or taking work", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-isolation-")));
  const path = join(root, "accounts.sqlite");
  const good = createInstance({
    id: "healthy",
    provider: "claude",
    label: "Healthy",
    homeDir: join(root, "healthy"),
  });
  const missing = ProviderInstance.parse({
    ...createInstance({
      id: "missing",
      provider: "claude",
      label: "Missing",
      homeDir: join(root, "account-homes", "missing"),
    }),
    managed: true,
  });
  await mkdir(good.homeDir);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,instance TEXT NOT NULL,quota TEXT NOT NULL)");
  for (const instance of [good, missing])
    db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
      instance.id,
      JSON.stringify(instance),
      JSON.stringify({ ...initialQuota(), auth: "logged_in" }),
    );
  db.close();
  const registry = await openRegistryIndex(path, undefined, root);
  try {
    await registry.ready;
    expect(registry.summaries(0)).toHaveLength(2);
    expect(registry.summary("missing", 0)).toMatchObject({
      availability: "unknown",
      quota: { blockers: { homeUnavailable: "home_missing" } },
    });
    expect(
      registry.pickInstance({ provider: "claude", role: "worker", estimatedLoad: 1 }, 0)?.id,
    ).toBe("healthy");
    await expect(registry.validateHome(missing)).rejects.toThrow("home_missing");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
