import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AcpIdentity } from "@ace/protocol";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "./index.ts";
import { executable, temporary } from "./testing/support.ts";

/*
 * A launch runs a pinned copy of the approved file, not the file an agent can rewrite between
 * ace hashing it and running it (ADR 0044 amendment, agents that update themselves). Only
 * resolved here: the fake native executables carry an ELF header and never run.
 */

const roots: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.close()));
});

async function open(root: string) {
  let id = 0;
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "snapshot.json"), () => String(++id)),
    now: () => 1,
    target: "linux-x86_64",
    fetch: async () => {
      throw new Error("No network expected");
    },
  });
  return AgentRegistry.open({
    catalog,
    root: join(root, "installations"),
    target: "linux-x86_64",
    env: {},
    storage: fileInventoryStorage(join(root, "inventory.json"), () => `write-${++id}`),
    now: () => 1,
    pinned: join(root, "pinned"),
    probe: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
}

async function home() {
  const f = await temporary();
  roots.push(f);
  return f.root;
}

/** Bytes that read as an ELF executable. */
const elf = (body: string) =>
  Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.from(body)]);

const custom: AcpIdentity = {
  acpAgentId: "local:custom",
  installationId: "custom-1",
  instanceId: "custom-1:default",
};

test("a native agent runs from ace's pinned copy of the approved bytes, copied once", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "agent");
    const approved = elf("approved build");
    await writeFile(agent, approved);
    await registry.bind({ ...custom, version: "1.0.0", command: agent, args: [] });
    const plan = await registry.resolve(custom);
    expect(plan.command).not.toBe(agent);
    expect(plan.command.startsWith(join(root, "pinned"))).toBe(true);
    expect(await readFile(plan.command)).toEqual(approved);
    // Read-only: an agent running as the person can't rewrite it by accident.
    expect((await stat(plan.command)).mode & 0o222).toBe(0);
    const copied = await stat(plan.command);
    const again = await registry.resolve(custom);
    expect(again.command).toBe(plan.command);
    expect((await stat(again.command)).ino).toBe(copied.ino);
    // The agent rewrites itself after ace checked it: what the launch runs is still approved.
    await writeFile(agent, elf("unseen build"));
    expect(await readFile(plan.command)).toEqual(approved);
    await expect(registry.resolve(custom)).rejects.toThrow("Approve the update");
  } finally {
    await registry.close();
  }
});

test("a pinned copy that no longer matches its approval is copied again from the approved file", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "agent");
    const approved = elf("approved build");
    await writeFile(agent, approved);
    await registry.bind({ ...custom, version: "1.0.0", command: agent, args: [] });
    const { command } = await registry.resolve(custom);
    await rm(command, { force: true });
    await writeFile(command, elf("tampered copy"));
    const plan = await registry.resolve(custom);
    expect(await readFile(plan.command)).toEqual(approved);
  } finally {
    await registry.close();
  }
});

test("a bridge's native CLI is pinned and handed to the bridge by its pinned path", async () => {
  const root = await home();
  const registry = await open(root);
  const identity: AcpIdentity = {
    acpAgentId: "official:claude-acp",
    installationId: "claude-acp-1",
    instanceId: "claude-acp-1:default",
  };
  try {
    const bridge = await executable(root, "claude-agent-acp");
    const claude = await executable(root, "claude");
    await writeFile(claude, elf("claude native"));
    await registry.bind({
      ...identity,
      version: "0.85.1",
      command: bridge,
      args: [],
      underlyingCommand: claude,
    });
    const plan = await registry.resolve(identity);
    // The bridge is a script: it runs in place, hashed just before.
    expect(plan.command).toBe(bridge);
    const pinned = plan.env["CLAUDE_CODE_EXECUTABLE"];
    expect(pinned).toBeDefined();
    expect(pinned).not.toBe(claude);
    expect(await readFile(pinned ?? "")).toEqual(elf("claude native"));
  } finally {
    await registry.close();
  }
});

test("a native executable that loads files beside it runs in place", async () => {
  const root = await home();
  const registry = await open(root);
  try {
    const agent = await executable(root, "agent");
    await writeFile(agent, elf("rpath $ORIGIN/../lib"));
    await registry.bind({ ...custom, version: "1.0.0", command: agent, args: [] });
    expect((await registry.resolve(custom)).command).toBe(agent);
    expect((await registry.resolve(custom)).command).toBe(agent);
  } finally {
    await registry.close();
  }
});
