import { digest } from "@ace/agent-registry";
import type { AcpIdentity } from "@ace/protocol";

/** Stable catalog identity for an approved ACP binding. */
export function acpModelInstanceId(identity: AcpIdentity): string {
  return `acp-${digest(JSON.stringify(identity))}`;
}
