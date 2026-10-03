import { expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountService,
  openRegistry,
  createAcpInstance,
  instanceEnv,
  acpIsolation,
  loginAcpAccount,
} from "./index.ts";
import { AcpIdentity, ThreadId } from "@ace/protocol";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { genericQuirks } from "@ace/adapter-acp";
import { spawnInteractive } from "@ace/provider-kit/process";

const identity = (agent: string) =>
  AcpIdentity.parse({
    acpAgentId: `local:${agent}`,
    installationId: `installed-${agent}`,
    instanceId: `installed-${agent}:default`,
  });
test("ACP default accounts share the user's existing home with distinct agent identity and no isolation claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-accounts-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  try {
    const one = createAcpInstance({ identity: identity("one"), label: "One", userHome: root });
    const two = createAcpInstance({ identity: identity("two"), label: "Two", userHome: root });
    await registry.register(one);
    await registry.register(two);
    expect(
      registry.summaries(1).map((row) => [row.acpAgentId, row.installationId, row.id]),
    ).toEqual([
      ["local:one", "installed-one", "installed-one:default"],
      ["local:two", "installed-two", "installed-two:default"],
    ]);
    expect(instanceEnv(one, { HOME: root, CLI_OWNED_SETTING: "retained" })).toEqual({
      HOME: root,
      CLI_OWNED_SETTING: "retained",
    });
    expect(acpIsolation()).toMatchObject({ status: "unsupported" });
    expect(() =>
      createAcpInstance({
        identity: identity("one"),
        label: "One",
        userHome: root,
        installation: {
          ...identity("two"),
          version: "1.0.0",
          profileRevision: "source",
          source: "local",
          evidence: "user_local_binding",
        },
      }),
    ).toThrow("identity mismatch");
    expect(
      registry.pickInstance({ provider: "acp", role: "worker", estimatedLoad: 1 }, 1),
    ).toBeUndefined();
    await expect(
      registry.register({ ...one, env: { CODEX_HOME: join(root, "unverified-home") } }),
    ).rejects.toThrow("no unverified selectors");
    await expect(registry.register({ ...one, acpAgentId: "local:two" })).rejects.toThrow(
      "identity",
    );
    const service = new AccountService({
      registry,
      now: () => 1,
      timeZone: "UTC",
      env: { HOME: root },
    });
    expect(
      await service.handle({
        type: "accounts.migrate",
        requestId: "migration",
        provider: "acp",
        from: one.id,
        to: two.id,
        nativeSessionId: "opaque-cli-owned",
      }),
    ).toMatchObject({ result: { status: "unsupported" } });
    expect(service.acpEnvironment(identity("one")).loginRevision).toBe("0");
    registry.loginChanged(one.id);
    expect(service.acpEnvironment(identity("one")).loginRevision).toBe("1");
    expect(service.acpEnvironment(identity("two")).loginRevision).toBe("0");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("account session binding preserves confirmed ACP selectors and negotiated support", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-binding-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  try {
    await registry.register(
      createAcpInstance({ identity: identity("one"), label: "One", userHome: root }),
    );
    const service = new AccountService({
      registry,
      now: () => 1,
      timeZone: "UTC",
      env: { HOME: root },
    });
    const adapter = createScriptedAdapter({
      provider: "acp",
      capabilities: genericQuirks.capabilities(),
      createTranslator: () => ({ translate: () => [], tick: () => [] }),
      steps: [],
    });
    let selected = "initial";
    const bound = service.bindAdapter({
      ...adapter,
      create: () => ({
        async openSession(context) {
          const session = await adapter.openSession(context);
          return {
            ...session,
            effectiveCapabilities: { ...genericQuirks.capabilities(), resume: true },
            async setModel(model: string) {
              selected = model;
            },
            async setMode(mode: string) {
              selected = mode;
            },
          };
        },
      }),
    });
    const session = await bound.openSession({
      threadId: ThreadId.parse("synthetic"),
      cwd: root,
      acpIdentity: identity("one"),
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    });
    try {
      expect(session.effectiveCapabilities?.resume).toBe(true);
      await session.setModel?.("confirmed");
      expect(selected).toBe("confirmed");
      await session.setMode?.("plan");
      expect(selected).toBe("plan");
    } finally {
      await session.close("user");
    }
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("local ACP login inherits only the selected instance environment and leaves credentials CLI-owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-login-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const instance = createAcpInstance({ identity: identity("one"), label: "One", userHome: root });
  try {
    await registry.register(instance);
    const marker = join(root, "login-environment.json");
    const result = await loginAcpAccount(registry, instance, {
      env: { HOME: root, SELECTED_INSTANCE: instance.id },
      resolve: async (_identity, env) => ({
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify({home: process.env.HOME, instance: process.env.SELECTED_INSTANCE}));`,
        ],
        env,
      }),
      spawn: spawnInteractive,
    });
    expect(result).toMatchObject({ status: "completed", code: 0 });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      home: root,
      instance: instance.id,
    });
    expect(registry.get(instance.id)?.instance.loginRevision).toBe("1");
    expect(registry.get(instance.id)?.quota.auth).toBe("unknown");
    expect(
      await loginAcpAccount(registry, instance, { env: {}, resolve: async () => undefined }),
    ).toMatchObject({ status: "unsupported" });
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
