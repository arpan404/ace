import type { Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { SessionContext, ProviderAdapter } from "@ace/engine-api";
import { capabilities } from "./capabilities.ts";
export { capabilities } from "./capabilities.ts";
import { type ServerOptions } from "./server.ts";
import { ServerPool } from "./server-pool.ts";
import { OpenCodeSession } from "./session.ts";
import { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeTranslator } from "./translator.ts";
export type { ServerOptions } from "./server.ts";
export type { Runtime } from "./runtime.ts";
export { OpenCodeServer } from "./server.ts";
export function createOpenCodeAdapter(
  options: ServerOptions = {},
): ProviderAdapter & { close(): Promise<void> } {
  const pool = new ServerPool(options);
  return {
    provider: "opencode" as const,
    capabilities,
    createTranslator: (init: { threadId: ThreadId; rootKey: Key }) => new OpenCodeTranslator(init),
    async openSession(ctx: SessionContext) {
      const lease = await pool.acquire(ctx);
      try {
        pool.assertOpen();
        const session = await OpenCodeSession.open(
          {
            ...ctx,
            onExit: (exit) => {
              void lease.release().catch(() => {});
              ctx.onExit(exit);
            },
          },
          lease.server,
        );
        return {
          ...(ctx.instanceId === undefined ? {} : { instanceId: ctx.instanceId }),
          get nativeSessionId() {
            return session.nativeSessionId;
          },
          send: (input, delivery, commandId) => session.send(input, delivery, commandId),
          interrupt: (target) => session.interrupt(target),
          resolve: (interaction, resolution) => session.resolve(interaction, resolution),
          stopTask: (task) => session.stopTask(task),
          async close(reason) {
            // A refused idle close still owns live work and its process lease.
            await session.close(reason);
            await lease.release();
          },
        };
      } catch (error) {
        // Preserve the opening cause while attempting both cleanup boundaries.
        await lease.release().catch(() => {});
        await lease.server.release().catch(() => {});
        throw error;
      }
    },
    close: () => pool.close(),
  };
}
export const opencodeAdapter = createOpenCodeAdapter();

export const adapter = opencodeAdapter;

export { discoverOpenCodeModels } from "./metadata.ts";

export { SessionOwnership } from "./ownership.ts";
