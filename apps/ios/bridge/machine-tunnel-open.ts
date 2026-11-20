import type { ClientCore } from "@ace/client";
import type { MachineTunnel } from "./machine-tunnel.ts";

/*
 * Opens a machine's localhost tunnel for its device tabs (ADR 0194). Until `@ace/client` ships
 * the tunnel, there is none: a device tab's connection to the machine's port reads as the
 * machine being unreachable, and public pages load as usual.
 */
export function openMachineTunnel(_client: ClientCore): MachineTunnel | undefined {
  return undefined;
}
