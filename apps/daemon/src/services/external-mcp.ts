import { externalMcp } from "../external-mcp/server.ts";
import type { ServiceContext } from "./types.ts";
export async function startExternalMcp(context: ServiceContext): Promise<void> {
  const server = await externalMcp(context);
  context.services.externalMcp = server;
  context.resources.own(() => server.close());
  context.resources.onShutdown(() => server.close());
}
