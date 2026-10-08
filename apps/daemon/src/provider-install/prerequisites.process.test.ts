import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "@ace/agent-registry";
import type { ProviderInstallProgress } from "@ace/protocol";
import { expect, test } from "vitest";
import { ProviderInstalls } from "./sessions.ts";
import { registryInstaller } from "./registry.ts";

test("a registry agent installs missing uv first and verifies the agent without restarting", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-uv-prerequisite-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const [name, path] of [
    ["bash", "/bin/bash"],
    ["sh", "/bin/sh"],
    ["env", "/usr/bin/env"],
  ]) {
    if (name && path) await symlink(path, join(bin, name));
  }
  const agentProgram = `#!${process.execPath}\nconsole.log('1.0.0');\n`;
  const uvProgram = `#!${process.execPath}\nconst fs=require('node:fs'); const p=require('node:path');
    fs.mkdirSync(process.env.UV_TOOL_BIN_DIR,{recursive:true});
    fs.writeFileSync(p.join(process.env.UV_TOOL_BIN_DIR,'fixture-agent'),${JSON.stringify(agentProgram)},{mode:0o700});\n`;
  const bootstrap = `#!${process.execPath}\nconst fs=require('node:fs'); const p=require('node:path');
    fs.mkdirSync(process.env.UV_INSTALL_DIR,{recursive:true});
    fs.writeFileSync(p.join(process.env.UV_INSTALL_DIR,'uv'),${JSON.stringify(uvProgram)},{mode:0o700});\n`;
  // Fake curl prints a local installer. No network or real package manager is used.
  const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(home, "bootstrap.cjs"))}\n`;
  await writeFile(join(home, "bootstrap.cjs"), bootstrap);
  await writeFile(
    join(bin, "curl"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(script)});\n`,
    { mode: 0o700 },
  );
  const env = { HOME: home, PATH: bin };
  let id = 0;
  const catalog = await AgentCatalog.open({
    target: "darwin-aarch64",
    now: () => 1000,
    cache: fileCache(join(home, "catalog.json"), () => String(++id)),
    fetch: async () =>
      new Response(
        JSON.stringify({
          version: "1.0.0",
          agents: [
            {
              id: "fixture",
              name: "Fixture",
              version: "1.0.0",
              description: "Synthetic",
              authors: ["Fixture"],
              license_url: "https://example.org/license",
              distribution: { uvx: { package: "fixture-agent==1.0.0", args: [], env: {} } },
            },
          ],
        }),
      ),
  });
  const registry = await AgentRegistry.open({
    catalog,
    root: join(home, "installs"),
    target: "darwin-aarch64",
    env,
    storage: fileInventoryStorage(join(home, "inventory.json"), () => String(++id)),
  });
  let command: string | undefined;
  const complete = Promise.withResolvers<ProviderInstallProgress>();
  const installs = new ProviderInstalls(
    {
      env,
      home,
      registry: registryInstaller(registry, async (_installation, path) => {
        command = path;
      }),
    },
    {
      now: () => 1000,
      id: () => String(++id),
      log() {},
      changed: async () => {},
      schedule(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
  );
  installs.listen((_owner, event) => {
    if (["succeeded", "failed", "cancelled"].includes(event.state)) complete.resolve(event);
  });
  try {
    const target = { provider: "acp" as const, acpAgentId: "official:fixture" };
    expect(await installs.plan(target, "install")).toMatchObject({
      status: "ready",
      method: "registry",
      prerequisite: { name: "uv" },
    });
    await installs.handle("device", {
      type: "provider.install.run",
      requestId: "install",
      ...target,
      action: "install",
      method: "registry",
    });
    expect(await complete.promise).toMatchObject({ state: "succeeded", version: "1.0.0" });
    if (!command) throw new Error("Agent not bound");
    expect((await promisify(execFile)(command, ["--version"], { env })).stdout.trim()).toBe(
      "1.0.0",
    );
    expect(await installs.plan(target, "install")).toMatchObject({
      status: "ready",
      registryPlan: { runtime: "uv" },
    });
  } finally {
    await installs.close();
    await registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("Copilot requires Node 22 before its registry installation can start", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-copilot-prerequisite-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nconsole.log('10.0.0');\n`, {
    mode: 0o700,
  });
  const nodePath = join(bin, "node");
  await writeFile(nodePath, `#!${process.execPath}\nconsole.log('v20.0.0');\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: bin };
  let id = 0;
  const catalog = await AgentCatalog.open({
    target: "darwin-aarch64",
    now: () => 1000,
    cache: fileCache(join(home, "catalog.json"), () => String(++id)),
    fetch: async () =>
      new Response(
        JSON.stringify({
          version: "1.0.0",
          agents: [
            {
              id: "github-copilot-cli",
              name: "Copilot",
              version: "1.0.0",
              description: "Synthetic",
              authors: ["Fixture"],
              license_url: "https://example.org/license",
              distribution: { npx: { package: "fixture-agent@1.0.0", args: [], env: {} } },
            },
          ],
        }),
      ),
  });
  const registry = await AgentRegistry.open({
    catalog,
    root: join(home, "installs"),
    target: "darwin-aarch64",
    env,
    storage: fileInventoryStorage(join(home, "inventory.json"), () => String(++id)),
  });
  const installs = new ProviderInstalls(
    { env, home, registry: registryInstaller(registry, async () => {}) },
    {
      now: () => 1000,
      id: () => String(++id),
      log() {},
      changed: async () => {},
      schedule() {
        return () => {};
      },
    },
  );
  try {
    const target = { provider: "acp" as const, acpAgentId: "official:github-copilot-cli" };
    expect(await installs.plan(target, "install")).toMatchObject({
      status: "unavailable",
      prerequisite: { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" },
    });
    await writeFile(nodePath, `#!${process.execPath}\nconsole.log('v22.0.0');\n`, { mode: 0o700 });
    expect(await installs.plan(target, "install")).toMatchObject({
      status: "ready",
      registryPlan: { runtime: "npm" },
    });
  } finally {
    await installs.close();
    await registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
