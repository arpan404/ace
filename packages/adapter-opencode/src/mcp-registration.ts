import { z } from "zod";
import { openCodeInjection, type AceMcpConnection } from "@ace/mcp-server";
import type { OpenCodeClient } from "@opencode/client";

const catalog = z
  .object({
    data: z
      .array(
        z
          .object({ name: z.string(), status: z.object({ status: z.string() }).passthrough() })
          .passthrough(),
      )
      .max(64),
  })
  .passthrough();
/** V2 runtime registrations are location-scoped and in memory, never config-file mutations. */
export async function registerAceMcp(
  client: OpenCodeClient,
  directory: string,
  connection: AceMcpConnection,
): Promise<void> {
  const location = { directory };
  const existing = catalog.parse(await client.mcp.list({ location }));
  if (existing.data.some((server) => server.name === "ace"))
    throw new Error("OpenCode MCP server name collision: ace");
  await client.mcp.add({ server: "ace", location, config: openCodeInjection(connection).server });
  // add starts asynchronously; connect waits for native startup and catalog loading.
  await client.mcp.connect({ server: "ace", location });
  const connected = catalog.parse(await client.mcp.list({ location }));
  if (
    !connected.data.some((server) => server.name === "ace" && server.status.status === "connected")
  )
    throw new Error("OpenCode could not connect its native ace MCP client");
}
