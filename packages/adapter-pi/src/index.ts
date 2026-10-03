import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { createPiTranslator } from "./translator.ts";
import { piCapabilities } from "./capabilities.ts";
import { openPiSession, type PiOptions, type PiSession } from "./session.ts";
import { forkPiSession } from "./fork.ts";
export { createPiTranslator } from "./translator.ts";
export { piCapabilities, piProfile, piPermissionArgs } from "./capabilities.ts";
export { openPiSession } from "./session.ts";
export type { PiOptions, PiSession } from "./session.ts";
export function createPiAdapter(options: PiOptions = {}): Omit<
  ProviderAdapter,
  "openSession" | "forkSession"
> & {
  openSession(ctx: SessionContext): Promise<PiSession>;
  forkSession(input: { nativeSessionId: string; signal: AbortSignal }): Promise<string>;
} {
  let forks = 0;
  return {
    provider: "pi",
    capabilities: piCapabilities,
    createTranslator: createPiTranslator,
    openSession: (ctx) => openPiSession(ctx, options),
    async forkSession(input) {
      if (forks >= 8) throw new Error("Pi cold fork capacity exceeded");
      forks++;
      try {
        return await forkPiSession(input, options);
      } finally {
        forks--;
      }
    },
  };
}
export const adapter = createPiAdapter();
export default adapter;

export { default as registerAcePiExtension } from "./extension.ts";
export type { PiExtensionApi } from "./extension-api.ts";
export { piHistoryErrorMessage } from "./history-errors.ts";
