import type { McpCapability } from "@ace/protocol";
import type { Services } from "./types.ts";

/** Lease ceiling for engine-owned and fallback sessions. Live settings, permissions and
 * grants filter discovery and calls, so enabling a group does not require a new credential. */
export function daemonMcpCapabilities(
  services: Pick<Partial<Services>, "devices" | "screen">,
): McpCapability[] {
  return [
    "agents",
    "notify",
    "thread_control",
    "automations",
    "projects",
    "browser",
    ...(services.devices ? ["devices" as const] : []),
    ...(services.screen ? ["screen" as const] : []),
  ];
}
