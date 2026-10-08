import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import type { Runtime } from "./runtime.ts";
import { mcpReadyRpc } from "./mcp-ready-contract.ts";

export const mcpReadyPluginDirectory = fileURLToPath(
  new URL("./mcp-ready-plugin", import.meta.url),
);

/** Add only a credential-free plugin. User config and persistent files stay provider-owned. */
export function mcpReadyEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  content: string,
  plugin: string,
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
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...plugins, plugin] }),
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
