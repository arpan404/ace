import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { ProviderKind } from "@ace/protocol";

const record = z.record(z.string().max(256), z.unknown());
const config = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
    serverUrl: z.string().optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
    enabled: z.boolean().optional(),
    status: z.string().max(128).optional(),
    config: z.unknown().optional(),
  })
  .passthrough();
export const DiscoveredMcpServer = z.strictObject({
  provider: ProviderKind,
  name: z.string().max(256),
  source: z.string().max(4096),
  transport: z.enum(["http", "sse", "stdio", "unknown"]),
  enabled: z.boolean(),
  status: z.string().max(128).optional(),
});
export type DiscoveredMcpServer = z.infer<typeof DiscoveredMcpServer>;
export interface DiscoveryApi {
  /** Read-only, bounded API result: Codex status/list, Claude mcpServerStatus, OpenCode GET /mcp. */
  read(signal: AbortSignal): Promise<unknown>;
}
export interface DiscoveryOptions {
  provider: ProviderKind;
  home: string;
  cwd: string;
  configPaths?: readonly string[];
  api?: DiscoveryApi;
  signal: AbortSignal;
}
export function discoveryPaths(provider: ProviderKind, home: string, cwd: string): string[] {
  switch (provider) {
    case "codex":
      return [join(home, ".codex/config.toml"), join(cwd, ".codex/config.toml")];
    case "claude":
      return [join(home, ".claude.json"), join(cwd, ".mcp.json")];
    case "opencode":
      return [
        join(home, ".config/opencode/opencode.json"),
        join(home, ".config/opencode/opencode.jsonc"),
        join(cwd, "opencode.json"),
        join(cwd, "opencode.jsonc"),
        join(cwd, ".opencode/opencode.json"),
        join(cwd, ".opencode/opencode.jsonc"),
      ];
    case "cursor":
      return [join(home, ".cursor/mcp.json"), join(cwd, ".cursor/mcp.json")];
    case "antigravity":
      return [join(home, ".gemini/config/mcp_config.json"), join(cwd, ".agents/mcp_config.json")];
    case "pi":
    case "acp":
      return [];
  }
}
export async function discoverMcpServers(options: DiscoveryOptions) {
  const paths = [
    ...new Set(options.configPaths ?? discoveryPaths(options.provider, options.home, options.cwd)),
  ];
  if (paths.length > 32) throw new Error("Discovery file capacity reached");
  const servers: DiscoveredMcpServer[] = [];
  const disabled = new Set<string>();
  const issues: { source: string; code: "unreadable" | "invalid" | "oversize" }[] = [];
  const append = (map: unknown, source: string) => {
    const decoded = record.parse(map);
    if (Object.keys(decoded).length + servers.length > 512)
      throw new Error("Discovery server capacity reached");
    for (const [name, value] of Object.entries(decoded)) {
      const parsed = config.safeParse(value);
      if (!parsed.success) continue; // Unknown provider config is tolerated, never exposed raw.
      const nested = config.safeParse(parsed.data.config);
      const item = nested.success ? { ...nested.data, ...parsed.data } : parsed.data;
      const transport =
        item.type === "sse"
          ? "sse"
          : item.url || item.serverUrl
            ? "http"
            : item.command
              ? "stdio"
              : "unknown";
      servers.push(
        DiscoveredMcpServer.parse({
          provider: options.provider,
          name,
          source,
          transport,
          enabled: item.enabled ?? item.status !== "disabled",
          ...(item.status === undefined ? {} : { status: item.status }),
        }),
      );
    }
  };
  for (const path of paths) {
    options.signal.throwIfAborted();
    let text: string;
    try {
      // Nonblocking open prevents FIFOs from retaining a filesystem worker while waiting
      // for a writer. Inspect the opened descriptor, avoiding a stat/open race.
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error("Expected regular file");
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          options.signal.throwIfAborted();
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > 1024 * 1024) {
          issues.push({ source: path, code: "oversize" });
          continue;
        }
        text = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) continue;
      issues.push({ source: path, code: "unreadable" });
      continue;
    }
    try {
      let value: unknown;
      if (path.endsWith(".toml")) value = parseToml(text);
      else {
        const errors: ParseError[] = [];
        value = parseJsonc(text, errors, { allowTrailingComma: true });
        if (errors.length) throw new Error("Invalid config");
      }
      const root = record.parse(value);
      const map =
        root[
          options.provider === "codex"
            ? "mcp_servers"
            : options.provider === "opencode"
              ? "mcp"
              : "mcpServers"
        ];
      if (map !== undefined) append(map, path);
      if (options.provider === "claude" && root.projects !== undefined) {
        const project = record.safeParse(record.parse(root.projects)[options.cwd]);
        if (project.success) {
          if (project.data.disabledMcpServers !== undefined) {
            const names = z
              .array(z.string().max(256))
              .max(512)
              .parse(project.data.disabledMcpServers);
            for (const name of names) disabled.add(name);
            if (disabled.size > 512) throw new Error("Discovery server capacity reached");
          }
          if (project.data.mcpServers !== undefined)
            append(project.data.mcpServers, `${path}#project`);
        }
      }
    } catch {
      issues.push({ source: path, code: "invalid" });
    }
  }
  if (options.api) {
    options.signal.throwIfAborted();
    try {
      const value = await options.api.read(options.signal);
      if (options.provider === "codex") {
        const rows = z
          .object({ data: z.array(z.object({ name: z.string() }).passthrough()).max(512) })
          .parse(value).data;
        append(Object.fromEntries(rows.map((row) => [row.name, row])), "api");
      } else if (options.provider === "claude") {
        const rows = z
          .array(z.object({ name: z.string() }).passthrough())
          .max(512)
          .parse(value);
        append(Object.fromEntries(rows.map((row) => [row.name, row])), "api");
      } else append(value, "api");
    } catch {
      issues.push({ source: "api", code: "invalid" });
    }
  }
  options.signal.throwIfAborted();
  // Project opt-outs apply to regular servers across config scopes and native API rows.
  for (const server of servers) if (disabled.has(server.name)) server.enabled = false;
  return { servers, issues };
}
