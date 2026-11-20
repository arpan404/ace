import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { RegistryPendingUpdate, type AcpIdentity, type RegistryResult } from "@ace/protocol";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "./index.ts";
import { executable, temporary } from "./testing/support.ts";

/**
 * The approved executable's `--version`, as a provider CLI would answer it: these fake agents
 * carry a `# version X` line. Counts the runs, so a test can see nothing ran.
 */
const probed: string[] = [];
const probe = async (command: string) => {
  probed.push(command);
  const version = /# version (\S+)/.exec(await readFile(command, "utf8"))?.[1];
  return version
    ? { code: 0, stdout: `agent ${version}\n`, stderr: "" }
    : { code: 1, stdout: "", stderr: "unknown option" };
};

const roots: { close(): Promise<void> }[] = [];
afterEach(async () => {
  probed.length = 0;
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
    pinned: join(root, "pinned"),
    probe,
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

/** The person approves exactly the update they were shown. */
function approve(
  registry: AgentRegistry,
  identity: AcpIdentity,
  update: RegistryPendingUpdate,
  extra: Record<string, unknown> = {},
): Promise<RegistryResult> {
  return registry.handle({
    type: "registry.approve-update",
    requestId: "approve",
    ...identity,
    executableDigest: update.executableDigest,
    ...(update.bridgeDigest ? { bridgeDigest: update.bridgeDigest } : {}),
    previousExecutableDigest: update.previousExecutableDigest,
    ...(update.previousBridgeDigest ? { previousBridgeDigest: update.previousBridgeDigest } : {}),
    generation: update.generation,
    ...extra,
  });
}

/** The one update listed now. */
async function onlyUpdate(registry: AgentRegistry): Promise<RegistryPendingUpdate> {
  const [update] = await updates(registry);
  if (!update) throw new Error("No update listed");
  return update;
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

    await writeFile(agent, `#!/bin/sh\ntouch '${marker}'\n# version 1.1.0\n`);
    // Every launch is refused, naming the agent and what lets it run.
    for (let launch = 0; launch < 2; launch++)
      await expect(registry.resolve(custom)).rejects.toThrow(
        "custom changed since you approved it, so ace won't run it. Approve the update in Settings → Providers to keep using it.",
      );
    const [update] = await updates(registry);
    expect(update).toMatchObject({ ...custom, changed: ["agent"], observedAt: 5000 });
    if (!update) throw new Error("No update listed");

    // Listing and refusing ran nothing.
    expect(probed).toEqual([]);
    expect((await approve(registry, custom, update)).result).toMatchObject({
      ok: true,
      installation: { ...custom, version: "1.1.0", versionSource: "probed" },
    });
    expect(registry.has(custom)).toBe(true);
    await expect(registry.resolve(custom)).resolves.toMatchObject({
      identity: custom,
      command: agent,
      version: "1.1.0",
    });
    expect(await updates(registry)).toEqual([]);
    // Approving ran only ace's own version probe of the approved file, once.
    expect(probed).toEqual([agent]);
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
        generation: 0,
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
    // Replaying an approval approves nothing: its generation is spent.
    expect((await approve(registry, custom, again)).result).toEqual({
      ok: false,
      reason: "This update was already approved or replaced; review it again",
    });
    await expect(registry.resolve(custom)).resolves.toMatchObject({ command: agent });
  } finally {
    await registry.close();
  }
});

/** One release of a fake agent, always reporting 1.0.0. */
const release = (name: string) => `#!/bin/sh\n# ${name}\n# version 1.0.0\n`;

test("an approval is good once: after A to B, B to C and back to B, replaying the first approves nothing", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "agent", release("A"));
    await bind(registry, custom, agent);
    await writeFile(agent, release("B"));
    const first = await onlyUpdate(registry);
    expect((await approve(registry, custom, first)).result.ok).toBe(true);
    await writeFile(agent, release("C"));
    expect((await approve(registry, custom, await onlyUpdate(registry))).result.ok).toBe(true);
    // B is on disk again, as the first approval named it; C is what the person approved last.
    await writeFile(agent, release("B"));
    const back = await onlyUpdate(registry);
    expect(back.executableDigest).toBe(first.executableDigest);
    expect((await approve(registry, custom, first)).result).toEqual({
      ok: false,
      reason: "This update was already approved or replaced; review it again",
    });
    await expect(registry.resolve(custom)).rejects.toThrow("Approve the update");
    // Approving what is listed now works, once.
    expect((await approve(registry, custom, back)).result).toMatchObject({
      ok: true,
      installation: { approvalGeneration: 3 },
    });
  } finally {
    await registry.close();
  }
});

test("a bridge's updated native CLI waits for approval, then runs under the bridge's profile, unverified", async () => {
  const root = await home();
  const registry = await open(root);
  const identity: AcpIdentity = {
    acpAgentId: "official:claude-acp",
    installationId: "claude-acp-1",
    instanceId: "claude-acp-1:default",
  };
  try {
    // The bridge ships in an npm package, whose manifest names its version.
    const folder = join(root, "claude-agent-acp");
    await mkdir(folder);
    const manifest = (version: string) =>
      writeFile(
        join(folder, "package.json"),
        JSON.stringify({
          name: "claude-agent-acp",
          version,
          bin: { "claude-agent-acp": "cli.js" },
        }),
      );
    await manifest("0.85.1");
    const bridge = await executable(folder, "cli.js", "#!/bin/sh\nexit 0\n");
    const claude = await executable(root, "claude", "#!/bin/sh\necho v1\n");
    await bind(registry, identity, bridge, "0.85.1", claude);
    await expect(registry.resolve(identity)).resolves.toMatchObject({
      profile: { id: "claude-bridge" },
      profileFit: "verified",
    });
    await rm(claude);
    await executable(root, "claude", "#!/bin/sh\necho v2\n");
    await manifest("0.90.0");
    await expect(registry.resolve(identity)).rejects.toThrow("Approve the update");
    const update = await onlyUpdate(registry);
    expect(update.changed).toEqual(["native_cli"]);
    expect((await approve(registry, identity, update)).result).toMatchObject({
      ok: true,
      installation: { version: "0.90.0", versionSource: "probed" },
    });
    // Read from its package: nothing ran.
    expect(probed).toEqual([]);
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

const gemini: AcpIdentity = {
  acpAgentId: "official:gemini",
  installationId: "gemini-1",
  instanceId: "gemini-1:default",
};

test("an update's version is the one ace reads from the approved files, never one the client sends", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "gemini", "#!/bin/sh\n# version 0.43.0\n");
    await bind(registry, gemini, agent, "0.43.0");
    await writeFile(agent, "#!/bin/sh\n# version 1.0.0\n");
    // A client claiming the profile's verified version gets nothing for it.
    expect(
      (await approve(registry, gemini, await onlyUpdate(registry), { version: "0.43.0" })).result,
    ).toMatchObject({
      ok: true,
      installation: { version: "1.0.0", profileRevision: "generic-v1" },
    });
    const plan = await registry.resolve(gemini);
    expect(plan.profile).toBeUndefined();
    expect(plan.profileFit).toBeUndefined();
  } finally {
    await registry.close();
  }
});

test("an updated agent claiming a profile's verified version still runs it unverified", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "gemini", "#!/bin/sh\nexit 0\n");
    await bind(registry, gemini, agent, "0.43.0");
    await writeFile(agent, "#!/bin/sh\n# version 0.43.0\n");
    expect((await approve(registry, gemini, await onlyUpdate(registry))).result.ok).toBe(true);
    await expect(registry.resolve(gemini)).resolves.toMatchObject({
      version: "0.43.0",
      profile: { id: "gemini-043" },
      profileFit: "compatible",
    });
  } finally {
    await registry.close();
  }
});

test("an update whose version ace can't read runs as generic ACP", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "gemini", "#!/bin/sh\n# version 0.43.0\n");
    await bind(registry, gemini, agent, "0.43.0");
    await writeFile(agent, "#!/bin/sh\nexit 0\n");
    expect((await approve(registry, gemini, await onlyUpdate(registry))).result).toMatchObject({
      ok: true,
      installation: { version: "unknown", profileRevision: "generic-v1" },
    });
    expect((await registry.resolve(gemini)).profile).toBeUndefined();
  } finally {
    await registry.close();
  }
});
