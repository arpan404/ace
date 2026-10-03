import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { createPiTranslator } from "./translator.ts";
import { piCapabilities } from "./capabilities.ts";
import { openPiSession, type PiOptions, type PiSession } from "./session.ts";
export { createPiTranslator } from "./translator.ts";
export { piCapabilities, piProfile, piPermissionArgs } from "./capabilities.ts";
export { openPiSession } from "./session.ts";
export type { PiOptions, PiSession } from "./session.ts";
export function createPiAdapter(
  options: PiOptions = {},
): Omit<ProviderAdapter, "openSession"> & { openSession(ctx: SessionContext): Promise<PiSession> } {
  return {
    provider: "pi",
    capabilities: piCapabilities,
    createTranslator: createPiTranslator,
    openSession: (ctx) => openPiSession(ctx, options),
  };
}
export const adapter = createPiAdapter();
export default adapter;

export { default as registerAcePiExtension } from "./extension.ts";
export type { PiExtensionApi } from "./extension-api.ts";
