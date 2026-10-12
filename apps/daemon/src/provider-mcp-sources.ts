import { z } from "zod";
import type { McpSources } from "@ace/protocol";

const servers = z
  .array(z.object({ name: z.string().min(1).max(256), status: z.string().optional() }))
  .max(512);
type Status = McpSources["servers"][number]["status"];
/**
 * Native status words across Claude (`needs-auth`), Codex and OpenCode (`needs_auth`,
 * `needs_client_registration`) and ACP (`authenticationRequired`).
 */
const statuses: Record<string, Status> = {
  connected: "connected",
  ready: "connected",
  disabled: "disabled",
  pending: "connecting",
  connecting: "connecting",
  starting: "connecting",
  failed: "failed",
  "needs-auth": "needs_auth",
  needs_auth: "needs_auth",
  needs_client_registration: "needs_auth",
  authenticationRequired: "needs_auth",
};
/** Public inventory deliberately excludes native config, tool arguments and errors. */
export function providerMcpSources(input: unknown): McpSources["servers"] {
  return servers
    .parse(input)
    .filter((server) => server.name !== "ace")
    .map((server) => ({
      name: server.name,
      status:
        (server.status && Object.hasOwn(statuses, server.status)
          ? statuses[server.status]
          : undefined) ?? "unknown",
    }));
}

const nativeStatusFrame = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.string(),
    request_id: z.string(),
    response: z.object({ mcpServers: z.unknown() }),
  }),
});

/** Native status provenance has the same inventory boundary as client responses. */
export function providerMcpStatusFrame(input: unknown): unknown {
  const parsed = nativeStatusFrame.safeParse(input);
  if (!parsed.success) return input;
  let inventory: McpSources["servers"] = [];
  try {
    inventory = providerMcpSources(parsed.data.response.response.mcpServers);
  } catch {
    // Malformed native inventory cannot retain credential-bearing configuration as raw data.
  }
  return {
    ...parsed.data,
    response: { ...parsed.data.response, response: { mcpServers: inventory } },
  };
}
