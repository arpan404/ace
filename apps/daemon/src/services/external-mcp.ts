import { externalMcp } from "../external-mcp/server.ts";
import type { ServiceContext } from "./types.ts";
export async function startExternalMcp(context: ServiceContext): Promise<void> {
  const server = await externalMcp(context);
  context.services.externalMcp = server;
  context.resources.own(() => server.close());
  context.resources.onShutdown(() => {
    // Shutdown doesn't wait for this callback, so the close is let go and reported.
    void server
      .close()
      .catch((error: unknown) =>
        context.log.log("warn", `Closing the outside MCP server failed: ${String(error)}`),
      );
  });
}
