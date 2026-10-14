import { storedAccess } from "@ace/provider-kit/access-modes";
import { Automation, ProviderKind } from "@ace/protocol";
import { z } from "zod";

const Stored = z
  .object({ provider: ProviderKind, permissionMode: z.string().optional() })
  .passthrough();

/**
 * Parse an automation, mapping a native `permissionMode` stored before the four ace modes onto
 * `access` once (ADR 0075); the next save writes only `access`.
 */
export function normalizeAutomation(input: unknown): Automation {
  const stored = Stored.safeParse(input);
  if (stored.success && stored.data.permissionMode !== undefined) {
    const { permissionMode, ...rest } = stored.data;
    const access = rest["access"] ?? storedAccess(rest.provider, permissionMode);
    return Automation.parse({ ...rest, ...(access ? { access } : {}) });
  }
  return Automation.parse(input);
}
