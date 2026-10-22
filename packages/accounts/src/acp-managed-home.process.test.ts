import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  antigravityIdentity,
  createAntigravityInstance,
  createManagedAcpInstance,
  instanceEnv,
  openRegistryIndex,
} from "./index.ts";

/** A daemon data root with private homes for the given managed account ids. */
async function dataRoot(...ids: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-acp-managed-")));
  const dataDir = join(root, "data");
  for (const id of ids) await mkdir(join(dataDir, "account-homes", id), { recursive: true });
  const registry = await openRegistryIndex(join(dataDir, "accounts.sqlite"), undefined, dataDir);
  await registry.ready;
  return {
    root,
    registry,
    home: (id: string) => join(dataDir, "account-homes", id),
    async close() {
      registry.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const antigravity = (id: string, homeDir: string) =>
  createManagedAcpInstance({
    id,
    identity: antigravityIdentity,
    label: id,
    homeDir,
  });

test("an added Antigravity account signs in inside its own home; the CLI login keeps the person's", async () => {
  const f = await dataRoot("work");
  try {
    const work = { ...antigravity("work", f.home("work")) };
    const person = { HOME: f.root, PATH: "/usr/bin", AGY_ACP_FORCE_FILE_STORAGE: undefined };
    expect(instanceEnv(work, person)).toEqual({
      HOME: f.root,
      PATH: "/usr/bin",
      GEMINI_HOME: f.home("work"),
      // Off the keychain, so this login never replaces the person's own.
      AGY_ACP_FORCE_FILE_STORAGE: "true",
    });
    expect(instanceEnv(createAntigravityInstance(f.root), person)).toEqual(person);
  } finally {
    await f.close();
  }
});

test("several Antigravity accounts register side by side, each in a home of its own", async () => {
  const f = await dataRoot("work", "personal");
  try {
    await f.registry.register(createAntigravityInstance(f.root));
    await f.registry.register(antigravity("work", f.home("work")));
    await f.registry.register(antigravity("personal", f.home("personal")));
    expect(
      f.registry
        .summaries(1)
        .map((row) => [row.id, row.acpAgentId, row.homeStrategy, row.isolation]),
    ).toEqual([
      ["antigravity-cli-default", antigravityIdentity.acpAgentId, "default_cli", "unsupported"],
      ["personal", antigravityIdentity.acpAgentId, "managed", undefined],
      ["work", antigravityIdentity.acpAgentId, "managed", undefined],
    ]);
    // Another account can't take over a home that's already in use.
    await expect(
      f.registry.register({ ...antigravity("intruder", f.home("work")), id: "intruder" }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("Antigravity's default is its CLI login until another account is chosen, apart from other agents", async () => {
  const f = await dataRoot("work");
  try {
    await f.registry.register(createAntigravityInstance(f.root));
    await f.registry.register(antigravity("work", f.home("work")));
    const defaults = () =>
      f.registry
        .summaries(1)
        .filter((row) => row.isDefault)
        .map((row) => row.id);
    expect(defaults()).toEqual(["antigravity-cli-default"]);
    f.registry.selectAcp(antigravityIdentity.acpAgentId, "work");
    expect(defaults()).toEqual(["work"]);
    expect(f.registry.selectedAcp(antigravityIdentity.acpAgentId)).toBe("work");
    expect(f.registry.selectedAcp("official:gemini")).toBeUndefined();
    // An account of one agent can't become another agent's default.
    expect(() => f.registry.selectAcp("official:gemini", "work")).toThrow();
  } finally {
    await f.close();
  }
});

test("an agent without a verified home profile can't have an added account", async () => {
  const f = await dataRoot("other");
  try {
    expect(() =>
      createManagedAcpInstance({
        id: "other",
        identity: { acpAgentId: "official:gemini", installationId: "gemini-cli" },
        label: "Other",
        homeDir: f.home("other"),
      }),
    ).toThrow(/unverified/);
  } finally {
    await f.close();
  }
});
