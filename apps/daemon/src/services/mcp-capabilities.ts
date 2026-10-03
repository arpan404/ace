import type { McpCapability } from "@ace/protocol";
import type { Services } from "./types.ts";

/** One authority list for engine-owned and fallback provider leases. */
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
