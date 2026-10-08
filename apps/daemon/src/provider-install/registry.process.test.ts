import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "@ace/agent-registry";
import { expect, test } from "vitest";
import { ProviderInstalls } from "./sessions.ts";
import { registryInstaller } from "./registry.ts";
import type { ProviderInstallProgress } from "@ace/protocol";

const runFile = promisify(execFile);
test("Antigravity installs its registry archive with companion files and binds the verified server", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-registry-"));
  const files = join(home, "archive");
  await mkdir(files);
  await writeFile(
    join(files, "agy_acp_server.par"),
    `#!${process.execPath}\nconsole.log('1.3.0');\n`,
    { mode: 0o700 },
  );
  await writeFile(join(files, "companion.dat"), "required companion");
  const zip = join(home, "server.zip");
  await runFile("/usr/bin/zip", ["-q", zip, "agy_acp_server.par", "companion.dat"], { cwd: files });
  const agent = {
    id: "antigravity-acp",
    name: "Antigravity",
    version: "1.3.0",
    description: "Synthetic",
    authors: ["Fixture"],
    license_url: "https://example.org/license",
    distribution: {
      binary: {
        "darwin-aarch64": {
          archive: "https://example.org/server.zip",
          cmd: "./agy_acp_server.par",
          args: [],
          env: {},
        },
      },
    },
  };
  let id = 0;
  const catalog = await AgentCatalog.open({
    target: "darwin-aarch64",
    now: () => 1000,
    cache: fileCache(join(home, "catalog.json"), () => String(++id)),
    fetch: async () => new Response(JSON.stringify({ version: "1.0.0", agents: [agent] })),
  });
  const registry = await AgentRegistry.open({
    catalog,
    root: join(home, "installs"),
    target: "darwin-aarch64",
    env: { HOME: home, PATH: "" },
    storage: fileInventoryStorage(join(home, "inventory.json"), () => String(++id)),
    runtime: { fetch: async () => new Response(await readFile(zip)) },
  });
  const bound: string[] = [];
  const terminal = Promise.withResolvers<ProviderInstallProgress>();
  const changed: string[] = [];
  const installs = new ProviderInstalls(
    {
      env: { HOME: home, PATH: "" },
      home,
      registry: registryInstaller(registry, async (_installation, command) => {
        bound.push(command);
      }),
    },
    {
      now: () => 1000,
      id: () => String(++id),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      log() {},
      changed: async (_plan, version) => {
        if (version) changed.push(version);
      },
    },
  );
  installs.listen((_owner, event) => {
    if (["succeeded", "failed", "cancelled"].includes(event.state)) terminal.resolve(event);
  });
  try {
    const plan = await installs.plan({ provider: "antigravity" }, "install");
    expect(plan).toMatchObject({
      status: "ready",
      method: "registry",
      needsAdmin: false,
      latestVersion: "1.3.0",
    });
    await installs.handle("device", {
      type: "provider.install.run",
      requestId: "install",
      provider: "antigravity",
      action: "install",
      method: "registry",
    });
    expect(await terminal.promise).toMatchObject({ state: "succeeded", version: "1.3.0" });
    expect(changed).toEqual(["1.3.0"]);
    const command = bound[0];
    if (!command) throw new Error("Server not bound");
    expect((await runFile(command, ["--version"], { env: { HOME: home } })).stdout.trim()).toBe(
      "1.3.0",
    );
    expect(await readFile(join(command, "..", "companion.dat"), "utf8")).toBe("required companion");
    expect(await installs.plan({ provider: "antigravity" }, "update")).toMatchObject({
      installedVersion: "1.3.0",
      updateAvailable: false,
    });
  } finally {
    await installs.close();
    await registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
