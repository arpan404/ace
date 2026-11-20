import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { RegistryPendingUpdate, type AcpIdentity, type RegistryResult } from "@ace/protocol";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "./index.ts";
import { executable, temporary } from "./testing/support.ts";

const roots: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.close()));
});

const noNetwork: typeof fetch = async () => {
  throw new Error("No network expected");
};

/** A registry over a temporary home, clock fixed at `now`, inventory on disk. */
async function open(root: string, now = 5000) {
  let id = 0;
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "snapshot.json"), () => String(++id)),
    now: () => now,
    target: "linux-x86_64",
    fetch: noNetwork,
  });
  return AgentRegistry.open({
    catalog,
    root: join(root, "installations"),
    target: "linux-x86_64",
    env: {},
    storage: fileInventoryStorage(join(root, "inventory.json"), () => `write-${++id}`),
    now: () => now,
  });
}

async function home() {
  const f = await temporary();
  roots.push(f);
  return f.root;
}

const custom: AcpIdentity = {
  acpAgentId: "local:custom",
  installationId: "custom-1",
  instanceId: "custom-1:default",
};

async function bind(
  registry: AgentRegistry,
  identity: AcpIdentity,
  command: string,
  version = "1.0.0",
  underlyingCommand?: string,
) {
  await registry.bind({
    ...identity,
    version,
    command,
    args: [],
    ...(underlyingCommand ? { underlyingCommand } : {}),
  });
}

/** The updates the person's Settings would list. */
async function updates(registry: AgentRegistry): Promise<RegistryPendingUpdate[]> {
  const reply = await registry.handle({
    type: "registry.list",
    requestId: "list",
    offset: 0,
    limit: 50,
  });
  if (!reply.result.ok || !("agents" in reply.result)) throw new Error("No listing");
  return reply.result.updates ?? [];
}

function approve(
  registry: AgentRegistry,
  identity: AcpIdentity,
  update: Pick<RegistryPendingUpdate, "executableDigest" | "bridgeDigest">,
  version?: string,
): Promise<RegistryResult> {
  return registry.handle({
    type: "registry.approve-update",
    requestId: "approve",
    ...identity,
    executableDigest: update.executableDigest,
    ...(update.bridgeDigest ? { bridgeDigest: update.bridgeDigest } : {}),
    ...(version ? { version } : {}),
  });
}

test("a changed agent never launches before the person approves it, then runs again under the same identity", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const marker = join(root, "launched");
    const agent = await executable(root, "agent", `#!/bin/sh\ntouch '${marker}'\n`);
    await bind(registry, custom, agent);
    await expect(registry.resolve(custom)).resolves.toMatchObject({ command: agent });
    expect(await updates(registry)).toEqual([]);

    await writeFile(agent, `#!/bin/sh\ntouch '${marker}'\n# updated\n`);
    // Every launch is refused, naming the agent and what lets it run.
    for (let launch = 0; launch < 2; launch++)
      await expect(registry.resolve(custom)).rejects.toThrow(
        "custom changed since you approved it, so ace won't run it. Approve the update in Settings → Providers to keep using it.",
      );
    const [update] = await updates(registry);
    expect(update).toMatchObject({ ...custom, changed: ["agent"], observedAt: 5000 });
    if (!update) throw new Error("No update listed");

    expect((await approve(registry, custom, update, "1.1.0")).result).toMatchObject({
      ok: true,
      installation: { ...custom, version: "1.1.0" },
    });
    expect(registry.has(custom)).toBe(true);
    await expect(registry.resolve(custom)).resolves.toMatchObject({
      identity: custom,
      command: agent,
      version: "1.1.0",
    });
    expect(await updates(registry)).toEqual([]);
    // Nothing above ran the agent: approving hashes, it never executes.
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await registry.close();
  }

  // The approval and its history survive a restart.
  const restarted = await open(root);
  try {
    await expect(restarted.resolve(custom)).resolves.toMatchObject({ version: "1.1.0" });
    const [installation] = restarted.inventory.list();
    const stored = z
      .array(z.object({ executableDigest: z.string() }))
      .parse(JSON.parse(await readFile(join(root, "inventory.json"), "utf8")));
    expect(installation?.approvals).toEqual([
      {
        approvedAt: 5000,
        previousVersion: "1.0.0",
        version: "1.1.0",
        previousExecutableDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        executableDigest: stored[0]?.executableDigest,
      },
    ]);
    expect(installation?.approvals?.[0]?.previousExecutableDigest).not.toBe(
      stored[0]?.executableDigest,
    );
  } finally {
    await restarted.close();
  }
});

test("an approval covers only the files the person was shown", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "agent", "#!/bin/sh\nexit 0\n");
    await bind(registry, custom, agent);
    await writeFile(agent, "#!/bin/sh\nexit 1\n");
    const [shown] = await updates(registry);
    if (!shown) throw new Error("No update listed");
    // It changes again after the person looked: their approval doesn't cover it.
    await writeFile(agent, "#!/bin/sh\nexit 2\n");
    expect((await approve(registry, custom, shown)).result).toEqual({
      ok: false,
      reason: "The agent changed again; review the update again",
    });
    await expect(registry.resolve(custom)).rejects.toThrow("Approve the update");
    const [again] = await updates(registry);
    expect(again?.executableDigest).not.toBe(shown.executableDigest);
    if (!again) throw new Error("No update listed");
    expect((await approve(registry, custom, again)).result.ok).toBe(true);
    // Replaying an approval once nothing has changed approves nothing.
    expect((await approve(registry, custom, again)).result).toEqual({
      ok: false,
      reason: "Nothing changed since approval",
    });
    await expect(registry.resolve(custom)).resolves.toMatchObject({ command: agent });
  } finally {
    await registry.close();
  }
});

test("a bridge's updated native CLI waits for approval, then runs under the bridge's profile", async () => {
  const root = await home();
  const registry = await open(root);
  const identity: AcpIdentity = {
    acpAgentId: "official:claude-acp",
    installationId: "claude-acp-1",
    instanceId: "claude-acp-1:default",
  };
  try {
    const bridge = await executable(root, "claude-agent-acp", "#!/bin/sh\nexit 0\n");
    const claude = await executable(root, "claude", "#!/bin/sh\necho v1\n");
    await bind(registry, identity, bridge, "0.85.1", claude);
    await expect(registry.resolve(identity)).resolves.toMatchObject({
      profile: { id: "claude-bridge" },
      profileFit: "verified",
    });
    await rm(claude);
    await executable(root, "claude", "#!/bin/sh\necho v2\n");
    await expect(registry.resolve(identity)).rejects.toThrow("Approve the update");
    const [update] = await updates(registry);
    expect(update?.changed).toEqual(["native_cli"]);
    if (!update) throw new Error("No update listed");
    // The bridge updated itself too, inside its profile's range.
    expect((await approve(registry, identity, update, "0.90.0")).result.ok).toBe(true);
    await expect(registry.resolve(identity)).resolves.toMatchObject({
      identity,
      env: { CLAUDE_CODE_EXECUTABLE: claude },
      profile: { id: "claude-bridge" },
      profileFit: "compatible",
    });
  } finally {
    await registry.close();
  }
});

test("an update to a version outside the profile's range runs without the profile", async () => {
  const root = await home();
  const registry = await open(root);
  const identity: AcpIdentity = {
    acpAgentId: "official:gemini",
    installationId: "gemini-1",
    instanceId: "gemini-1:default",
  };
  try {
    const gemini = await executable(root, "gemini", "#!/bin/sh\necho 0.43\n");
    await bind(registry, identity, gemini, "0.43.0");
    await writeFile(gemini, "#!/bin/sh\necho 1.0\n");
    await expect(registry.resolve(identity)).rejects.toThrow("Approve the update");
    const [update] = await updates(registry);
    if (!update) throw new Error("No update listed");
    expect((await approve(registry, identity, update, "1.0.0")).result).toMatchObject({
      ok: true,
      installation: { version: "1.0.0", profileRevision: "generic-v1" },
    });
    const plan = await registry.resolve(identity);
    expect(plan.profile).toBeUndefined();
    expect(plan.profileFit).toBeUndefined();
  } finally {
    await registry.close();
  }
});
