import { mkdtemp, rm, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCatalog,
  AgentRegistry,
  fileCache,
  fileInventoryStorage,
  digest,
  type AgentEntry,
} from "../index.ts";
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ace-acpreg-"));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}
export function body(agents: unknown[]) {
  return JSON.stringify({ version: "1.0.0", agents });
}
export function sample(version = "1.0.0"): AgentEntry {
  return {
    id: "sample",
    name: "Sample",
    version,
    description: "Synthetic",
    authors: ["Fixture"],
    license_url: "https://example.org/license",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://example.org/artifact",
          cmd: "agent",
          args: [],
          env: {},
          sha256: digest("synthetic artifact"),
        },
      },
    },
  };
}
export async function executable(
  root: string,
  name: string,
  content = "#!/bin/sh\nexit 0\n",
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  await chmod(path, 0o700);
  return realpath(path);
}
export async function registry(
  root: string,
  request: typeof fetch,
  artifact: typeof fetch = request,
  managers?: Partial<Record<"npm" | "uv", string>>,
) {
  let id = 0;
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "snapshot.json"), () => String(++id)),
    now: () => 1000,
    target: "linux-x86_64",
    fetch: request,
  });
  const service = await AgentRegistry.open({
    catalog,
    root: join(root, "installations"),
    target: "linux-x86_64",
    env: process.env,
    storage: fileInventoryStorage(join(root, "inventory.json"), () => String(++id)),
    runtime: { fetch: artifact },
    ...(managers ? { managers } : {}),
  });
  return service;
}
