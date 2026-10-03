import type { Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { SessionContext, ProviderAdapter } from "@ace/engine-api";
import { capabilities } from "./capabilities.ts";
export { capabilities } from "./capabilities.ts";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { OpenCodeSession } from "./session.ts";
import { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeTranslator } from "./translator.ts";
export type { ServerOptions } from "./server.ts";
export type { Runtime } from "./runtime.ts";
export { OpenCodeServer } from "./server.ts";
export function createOpenCodeAdapter(
  options: ServerOptions = {},
): ProviderAdapter & { close(): Promise<void> } {
  const server = new OpenCodeServer(options);
  return {
    provider: "opencode" as const,
    capabilities,
    createTranslator: (init: { threadId: ThreadId; rootKey: Key }) => new OpenCodeTranslator(init),
    async openSession(ctx: SessionContext) {
      if (!ctx.env) return OpenCodeSession.open(ctx, server);
      const isolated = new OpenCodeServer({
        ...options,
        discovery: { ...options.discovery, env: ctx.env },
      });
      const onAbort = () => {
        void isolated.close();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const session = await OpenCodeSession.open(ctx, isolated);
        return {
          ...session,
          get nativeSessionId() {
            return session.nativeSessionId;
          },
          send: (input, delivery) => session.send(input, delivery),
          interrupt: (target) => session.interrupt(target),
          resolve: (interaction, resolution) => session.resolve(interaction, resolution),
          stopTask: (task) => session.stopTask(task),
          async close(reason) {
            try {
              await session.close(reason);
            } finally {
              ctx.signal.removeEventListener("abort", onAbort);
              await isolated.close();
            }
          },
        };
      } catch (error) {
        ctx.signal.removeEventListener("abort", onAbort);
        await isolated.close();
        throw error;
      }
    },
    close: () => server.close(),
  };
}
export const opencodeAdapter = createOpenCodeAdapter();

export const adapter = opencodeAdapter;

export { discoverOpenCodeModels } from "./metadata.ts";

export { SessionOwnership } from "./ownership.ts";
