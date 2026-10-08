import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { harnessCatalog } from "@ace/commands";
import { z } from "zod";
import type { CatalogEntry } from "@ace/protocol";
const page = z.object({
  data: z.array(z.unknown()).max(512),
  nextCursor: z.string().max(4096).nullish(),
});
/** Read-only app-server queries, with no thread/start, auth operation or model prompt. */
export async function discoverCodexExtensions(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
}): Promise<CatalogEntry[]> {
  options.signal.throwIfAborted();
  const proc = (options.spawn ?? spawnSupervised)({
    command: options.executable,
    args: ["app-server"],
    cwd: options.cwd,
    env: options.env,
    name: "extension-discovery",
    maxOutputBytes: 4 * 1024 * 1024,
    maxLineBytes: 1024 * 1024,
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const rpc = new JsonRpcPeer(proc, { timeoutMs: 5000 });
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "ace_catalog", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
      { signal: options.signal },
    );
    rpc.notify("initialized");
    const entries: CatalogEntry[] = [];
    for (const method of ["skills/list", "app/list", "mcpServerStatus/list"]) {
      const data: unknown[] = [];
      let cursor: string | undefined;
      try {
        for (let count = 0; count < 6; count++) {
          const result = page.parse(
            await rpc.request(
              method,
              method === "skills/list"
                ? { cwds: [options.cwd], forceReload: true }
                : { limit: 100, ...(cursor ? { cursor } : {}) },
              { signal: options.signal },
            ),
          );
          data.push(...result.data.slice(0, 512 - data.length));
          if (!result.nextCursor || result.nextCursor === cursor || data.length >= 512) break;
          cursor = result.nextCursor;
        }
        entries.push(
          ...(harnessCatalog("codex", method, { data }, options.cwd) ?? []).slice(
            0,
            512 - entries.length,
          ),
        );
      } catch {
        /* Unsupported methods leave the other extension types usable. */
      }
    }
    return entries;
  } finally {
    rpc.close();
    options.signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}
