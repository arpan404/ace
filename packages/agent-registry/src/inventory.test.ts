import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindLocal, LocalInventory } from "./inventory.ts";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ace-inventory-"));
  directories.push(path);
  return path;
}
async function file(root: string, name: string, content = "stand-in") {
  const path = join(root, name);
  await writeFile(path, content);
  await chmod(path, 0o755);
  return realpath(path);
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("Windows script bindings", () => {
  it.each([["agent.js"], ["agent.cjs"], ["agent.mjs"]])(
    "launches %s through the node on PATH",
    async (name) => {
      const root = await directory();
      const bin = await directory();
      const node = await file(bin, "node");
      const script = await file(root, name);
      const bound = await bindLocal(
        {
          acpAgentId: "local:custom",
          installationId: "custom-1",
          instanceId: "custom-1:default",
          version: "1",
          command: script,
          args: ["--stdio"],
        },
        { PATH: bin },
        "win32",
      );
      expect(bound.command).toBe(node);
      expect(bound.args).toEqual([script, "--stdio"]);
    },
  );

  it("refuses a script entrypoint when node is missing from PATH", async () => {
    const root = await directory();
    const script = await file(root, "agent.js");
    await expect(
      bindLocal(
        {
          acpAgentId: "local:custom",
          installationId: "custom-1",
          instanceId: "custom-1:default",
          version: "1",
          command: script,
          args: [],
        },
        { PATH: root },
        "win32",
      ),
    ).rejects.toThrow("Node unavailable");
  });

  it("leaves native Windows executables alone", async () => {
    const root = await directory();
    const exe = await file(root, "agent.exe");
    const bound = await bindLocal(
      {
        acpAgentId: "local:custom",
        installationId: "custom-1",
        instanceId: "custom-1:default",
        version: "1",
        command: exe,
        args: ["--stdio"],
      },
      { PATH: root },
      "win32",
    );
    expect(bound.command).toBe(exe);
    expect(bound.args).toEqual(["--stdio"]);
  });

  it("binds the script directly on POSIX", async () => {
    const root = await directory();
    const script = await file(root, "agent.js");
    const bound = await bindLocal(
      {
        acpAgentId: "local:custom",
        installationId: "custom-1",
        instanceId: "custom-1:default",
        version: "1",
        command: script,
        args: ["--stdio"],
      },
      { PATH: root },
      "darwin",
    );
    expect(bound.command).toBe(script);
    expect(bound.args).toEqual(["--stdio"]);
  });

  it("revalidates the script behind a node launch while node upgrades keep approval", async () => {
    const root = await directory();
    const bin = await directory();
    const node = join(bin, "node");
    await writeFile(node, "node-v1");
    await chmod(node, 0o755);
    const script = join(root, "agent.js");
    await writeFile(script, "agent-v1");
    await chmod(script, 0o755);
    const bound = await bindLocal(
      {
        acpAgentId: "local:custom",
        installationId: "custom-1",
        instanceId: "custom-1:default",
        version: "1",
        command: script,
        args: [],
      },
      { PATH: bin },
      "win32",
    );
    const inventory = new LocalInventory([bound]);
    const identity = {
      acpAgentId: "local:custom",
      installationId: "custom-1",
      instanceId: "custom-1:default",
    };
    const plan = await inventory.resolve(identity, {});
    expect(plan.command).toBe(await realpath(node));
    expect(plan.args).toEqual([await realpath(script)]);
    await writeFile(node, "node-v2");
    await expect(inventory.resolve(identity, {})).resolves.toMatchObject({
      command: await realpath(node),
    });
    await writeFile(script, "agent-v2");
    await expect(inventory.resolve(identity, {})).rejects.toThrow("changed");
  });
});
