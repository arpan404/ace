import type { CursorAdapterOptions } from "@ace/adapter-cursor";
import type { ServiceContext } from "./types.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { releaseMcpControllers } from "./provider-mcp.ts";

/** Cursor's SDK host owns its transport; it still needs the daemon's complete scoped toolkit. */
export async function openCursorMcp(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  session: Parameters<NonNullable<CursorAdapterOptions["mcp"]>>[0],
) {
  const { services, store } = context;
  const mcp = services.mcp;
  const root = store.getThread(session.threadId)?.rootAgentId;
  if (!mcp || !root) throw new Error("Cursor MCP caller is not available");
  const lease = mcp.openSession(
    {
      sessionId: context.id(),
      threadId: session.threadId,
      agentId: root,
      capabilities: daemonMcpCapabilities(services),
    },
    session.signal,
  );
  const release = () => releaseMcpControllers(services, session.threadId, root);
  lease.principal.signal.addEventListener("abort", release, { once: true });
  return { connection: { url: mcp.url, bearer: lease.bearer }, end: lease.end };
}
