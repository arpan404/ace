import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Saved = z.object({ port: z.number().int().min(1024).max(65535) });

/**
 * The outside endpoint's port, kept in the daemon's data directory so a pasted client config
 * still works after a restart (ADR 0122). Unreadable or missing: none saved yet.
 */
export function endpointPort(dataDir: string) {
  const path = join(dataDir, "mcp-outside-endpoint.json");
  return {
    read(): number | undefined {
      try {
        return Saved.parse(JSON.parse(readFileSync(path, "utf8"))).port;
      } catch {
        return undefined;
      }
    },
    save(port: number): void {
      writeFileSync(path, JSON.stringify(Saved.parse({ port })), { mode: 0o600 });
    },
  };
}
