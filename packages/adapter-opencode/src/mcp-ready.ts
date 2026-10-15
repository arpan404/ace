import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import type { Runtime } from "./runtime.ts";
import { mcpReadyRpc } from "./mcp-ready-contract.ts";

export function mcpReadyPluginDirectory(): string {
  return fileURLToPath(new URL("./mcp-ready-plugin", import.meta.url));
}

/**
 * Add ace's credential-free extras to OpenCode's runtime config: the readiness plugin for owned
 * MCP sessions and ace's shipped skill directories. OpenCode adds `skills` paths from this
 * layer to the person's own (checked against OpenCode 2.0.29's skill API), and user config and
 * persistent files stay provider-owned.
 */
export function aceConfigEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  content: string,
  extras: { plugin?: string | undefined; skills?: readonly string[] | undefined },
): NodeJS.ProcessEnv {
  if (Buffer.byteLength(content) > 256 * 1024)
    throw new Error("OpenCode configuration exceeds limit");
  const errors: ParseError[] = [];
  const config = z
    .record(z.string(), z.unknown())
    .parse(parse(content, errors, { allowTrailingComma: true }));
  if (errors.length) throw new Error("Invalid OpenCode configuration");
  const plugins = z
    .array(z.unknown())
    .max(64)
    .parse(config["plugins"] ?? []);
  const skills = z
    .array(z.string())
    .max(64)
    .parse(config["skills"] ?? []);
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      ...(extras.plugin ? { plugins: [...plugins, extras.plugin] } : {}),
      ...(extras.skills?.length ? { skills: [...skills, ...extras.skills] } : {}),
    }),
  };
}

export async function waitForAceTools(
  client: OpenCodeClient,
  directory: string,
  runtime: Runtime,
): Promise<void> {
  const controller = new AbortController();
  const cancel = runtime.schedule(() => controller.abort(), 10_000);
  try {
    const catalog = z
      .object({ tools: z.array(z.object({ name: z.string(), description: z.string() })).max(256) })
      .parse(
        await client
          .rpc(mcpReadyRpc)
          .ready({}, { location: { directory }, signal: controller.signal }),
      );
    if (
      !catalog.tools.some(
        (tool) => tool.name === "ace_ace_status" && tool.description.includes("ace://status"),
      )
    )
      throw new Error("OpenCode ace status tool is missing from its native catalog");
  } finally {
    cancel();
  }
}
