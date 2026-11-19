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
/** Whether a server named `ace` is listed in this location, whoever added it. */
export async function aceMcpListed(client: OpenCodeClient, directory: string): Promise<boolean> {
  const listed = catalog.parse(await client.mcp.list({ location: { directory } }));
  return listed.data.some((server) => server.name === "ace");
}

/**
 * Adds ace's server to one location. V2 runtime registrations are location-scoped and in
 * memory, never config-file mutations. Callers check `aceMcpListed` first: a server already
 * named `ace` there may be the person's own.
 */
export async function addAceMcp(
  client: OpenCodeClient,
  directory: string,
  connection: AceMcpConnection,
): Promise<void> {
  await client.mcp.add({
    server: "ace",
    location: { directory },
    config: openCodeInjection(connection).server,
  });
}

/** Connects the `ace` server ace added. add starts asynchronously; connect waits for native startup and catalog loading. */
export async function connectAceMcp(client: OpenCodeClient, directory: string): Promise<void> {
  const location = { directory };
  await client.mcp.connect({ server: "ace", location });
  const connected = catalog.parse(await client.mcp.list({ location }));
  if (
    !connected.data.some((server) => server.name === "ace" && server.status.status === "connected")
  )
    throw new Error("OpenCode could not connect its native ace MCP client");
}
