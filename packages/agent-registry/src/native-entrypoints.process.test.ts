import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { RegistryResult } from "@ace/protocol";
import {
  AgentCatalog,
  AgentRegistry,
  digest,
  fileCache,
  fileInventoryStorage,
  type AgentEntry,
} from "./index.ts";
import { body, sample, temporary } from "./testing/support.ts";

const run = promisify(execFile);
const target = process.arch === "arm64" ? "windows-aarch64" : "windows-x86_64";

/** A stored ZIP with DOS-made entries, as Windows release zips are written. */
function storedZip(files: readonly { name: string; content: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc32(data), 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The daemon environment with PATH and the per-user folders pointed at the test's own. */
function environment(path: string, profile: string): NodeJS.ProcessEnv {
  const replaced = new Set(["PATH", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "SCOOP"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  return {
    ...env,
    Path: `${path};${dirname(process.execPath)};${system}`,
    USERPROFILE: profile,
    LOCALAPPDATA: join(profile, "AppData", "Local"),
    APPDATA: join(profile, "AppData", "Roaming"),
  };
}

/** A runnable `.cmd` shim around a CommonJS Node script, as npm and other installers write. */
async function shim(path: string, source: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.cjs`, source);
  await writeFile(`${path}.cmd`, `@"${process.execPath}" "${path}.cjs" %*\r\n`);
  return `${path}.cmd`;
}

async function open(root: string, agent: AgentEntry, env: NodeJS.ProcessEnv, artifact?: Buffer) {
  let id = 0;
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "snapshot.json"), () => String(++id)),
    now: () => 1000,
    target,
    fetch: async () => new Response(body([agent])),
  });
  return AgentRegistry.open({
    catalog,
    root: join(root, "installations"),
    target,
    env,
    storage: fileInventoryStorage(join(root, "inventory.json"), () => String(++id)),
    runtime: { fetch: async () => new Response(artifact ?? "missing") },
  });
}

async function install(service: AgentRegistry, runtime: "binary" | "npm" | "uv") {
  await service.catalog.refresh();
  const preview = await service.handle({
    type: "registry.install-plan",
    requestId: "plan",
    acpAgentId: "official:sample",
    runtime,
  });
  if (!preview.result.ok || !("plan" in preview.result))
    throw new Error(`No ${runtime} plan: ${JSON.stringify(preview.result)}`);
  const reply: RegistryResult = await service.handle({
    type: "registry.install-intent",
    requestId: "install",
    intentId: `${runtime}-approved`,
    digest: preview.result.plan.digest,
  });
  if (!reply.result.ok || !("installation" in reply.result))
    throw new Error(`No ${runtime} installation: ${JSON.stringify(reply.result)}`);
  // The inventory write is confirmed durable, not merely published.
  expect(reply.result).not.toHaveProperty("durability");
  return { plan: preview.result.plan, installation: reply.result.installation };
}

describe.runIf(process.platform === "win32")("Windows registry installs", () => {
  it("a release zip with a .exe entrypoint named without its extension installs and resolves", async () => {
    const work = await temporary();
    const zip = storedZip([
      { name: "agent.exe", content: "native agent" },
      { name: "lib\\helper.dll", content: "helper" },
    ]);
    const agent: AgentEntry = {
      ...sample(),
      distribution: {
        binary: {
          [target]: {
            archive: "https://example.org/agent-windows.zip",
            cmd: "./agent",
            args: ["--acp"],
            env: {},
            sha256: digest(zip),
          },
        },
      },
    };
    const service = await open(work.root, agent, environment(work.root, work.root), zip);
    try {
      const { installation } = await install(service, "binary");
      expect(installation.evidence).toBe("sha256");
      const launch = await service.resolve(installation);
      expect(launch.command).toMatch(/\\files\\agent\.exe$/);
      expect(launch.args).toEqual(["--acp"]);
      expect(await readFile(launch.command, "utf8")).toBe("native agent");
      expect(await readFile(join(dirname(launch.command), "lib", "helper.dll"), "utf8")).toBe(
        "helper",
      );
    } finally {
      await service.close();
      await work.close();
    }
  });

  it("npm.cmd found on PATH installs a package whose JS bin then runs under node", async () => {
    const work = await temporary();
    const tools = join(work.root, "tools");
    const npm = await shim(
      join(tools, "npm"),
      `const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] !== "install" || args.at(-1) !== "sample@1.0.0" || args.at(-2) !== "--") process.exit(3);
const root = args[args.indexOf("--prefix") + 1];
const pkg = join(root, "node_modules", "sample");
mkdirSync(join(pkg, "bin"), { recursive: true });
writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0", bin: { sample: "bin/entry.js" } }));
writeFileSync(join(pkg, "bin", "entry.js"), 'process.stdout.write("acp ready " + process.argv.slice(2).join(" "));');
writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/sample": { version: "1.0.0", integrity: "sha512-c3ludGhldGlj" } } }));
`,
    );
    const agent: AgentEntry = {
      ...sample(),
      distribution: { npx: { package: "sample@1.0.0", args: ["--stdio"], env: {} } },
    };
    const env = environment(tools, work.root);
    const service = await open(work.root, agent, env);
    try {
      const { plan, installation } = await install(service, "npm");
      expect(plan.argv[0]).toBe(npm);
      expect(installation.packageManager).toEqual({
        command: npm,
        package: "sample@1.0.0",
        integrity: "sha512-c3ludGhldGlj",
      });
      const launch = await service.resolve(installation);
      expect(launch.command).toBe(await realpath(process.execPath));
      expect(launch.args[0]).toMatch(/\\node_modules\\sample\\bin\\entry\.js$/);
      const { stdout } = await run(launch.command, [...launch.args]);
      expect(stdout).toBe("acp ready --stdio");
    } finally {
      await service.close();
      await work.close();
    }
  });

  it("uv missing from PATH is found in %USERPROFILE%\\.local\\bin and its single .exe binds", async () => {
    const work = await temporary();
    const uv = await shim(
      join(work.root, ".local", "bin", "uv"),
      `const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args.join(" ") !== "tool install --no-progress -- sample==1.0.0") process.exit(3);
const bin = process.env.UV_TOOL_BIN_DIR;
if (!bin || !process.env.UV_TOOL_DIR) process.exit(4);
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "sample-agent.exe"), "python trampoline");
`,
    );
    const agent: AgentEntry = {
      ...sample(),
      distribution: { uvx: { package: "sample==1.0.0", args: [], env: {} } },
    };
    const service = await open(work.root, agent, environment(join(work.root, "empty"), work.root));
    try {
      const { plan, installation } = await install(service, "uv");
      expect(plan.argv[0]).toBe(uv);
      expect(installation.packageManager).toEqual({ command: uv, package: "sample==1.0.0" });
      const launch = await service.resolve(installation);
      expect(launch.command).toMatch(/\\bin\\sample-agent\.exe$/);
      expect(await readFile(launch.command, "utf8")).toBe("python trampoline");
    } finally {
      await service.close();
      await work.close();
    }
  });
});
