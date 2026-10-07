import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { createPiTranslator } from "./translator.ts";
import { piCapabilities } from "./capabilities.ts";
import type { PiOptions, PiSession } from "./session.ts";

/** Register metadata synchronously; load process and history I/O only on use. */
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
    async openSession(ctx) {
      const { openPiSession } = await import("./session.ts");
      return openPiSession(ctx, options);
    },
    async forkSession(input) {
      if (forks >= 8) throw new Error("Pi cold fork capacity exceeded");
      forks++;
      try {
        const { forkPiSession } = await import("./fork.ts");
        return await forkPiSession(input, options);
      } finally {
        forks--;
      }
    },
  };
}

export const adapter = createPiAdapter();
export default adapter;
