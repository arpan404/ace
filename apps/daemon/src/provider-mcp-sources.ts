import { z } from "zod";
import type { McpSources } from "@ace/protocol";

const servers = z
  .array(z.object({ name: z.string().min(1).max(256), status: z.string().optional() }))
  .max(512);
/** Public inventory deliberately excludes native config, tool arguments and errors. */
export function providerMcpSources(input: unknown): McpSources["servers"] {
  return servers
    .parse(input)
    .filter((server) => server.name !== "ace")
    .map((server) => ({
      name: server.name,
      status:
        server.status === "connected" || server.status === "ready"
          ? "connected"
          : server.status === "disabled"
            ? "disabled"
            : server.status === "pending" ||
                server.status === "connecting" ||
                server.status === "starting"
              ? "connecting"
              : server.status === "failed" ||
                  server.status === "needs_auth" ||
                  server.status === "authenticationRequired"
                ? "failed"
                : "unknown",
    }));
}
