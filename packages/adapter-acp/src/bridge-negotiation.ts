import { z } from "zod";
import type { CompatibilityProfile } from "@ace/agent-registry";
const object = z.record(z.string(), z.unknown());
const air = z
  .object({ version: z.number().int().min(1), capabilities: z.array(z.string().max(128)).max(128) })
  .passthrough();
/** Opt into only the reviewed child-session contract; no AIR background/auth extensions. */
export function clientMeta(
  meta: Readonly<Record<string, unknown>>,
  profile?: CompatibilityProfile,
): Record<string, unknown> {
  if (!profile?.subagentSessions) return { ...meta };
  return { ...meta, jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } };
}
/** Draft fields remain raw and malformed extension claims disable support rather than closing ACP. */
export function bridgeSubagents(raw: unknown, profile?: CompatibilityProfile): boolean {
  if (!profile?.subagentSessions) return false;
  const response = object.safeParse(raw).data;
  const capabilities = object.safeParse(response?.agentCapabilities).data;
  const sessions = object.safeParse(capabilities?.sessionCapabilities).data;
  if (sessions && Object.hasOwn(sessions, "subagents"))
    return object.safeParse(sessions.subagents).success;
  const meta = object.safeParse(response?.["_meta"]).data;
  const jetbrains = object.safeParse(meta?.jetbrains).data;
  const declaration = air.safeParse(jetbrains?.air).data;
  return declaration?.capabilities.includes("nativeSubagentSessions") ?? false;
}
