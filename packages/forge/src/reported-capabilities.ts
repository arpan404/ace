import type { ForgeRepository } from "@ace/protocol/forge";
import { forgeCapabilities } from "./forge-capabilities.ts";

/** Attach the adapter's declared capabilities to a detail returned to a client. */
export function withForgeCapabilities<T extends object>(value: T, repository: ForgeRepository) {
  return { ...value, capabilities: [...forgeCapabilities[repository.forge]] };
}
