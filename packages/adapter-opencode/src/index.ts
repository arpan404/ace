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
  const instances = new Set<OpenCodeServer>();
  return {
    provider: "opencode" as const,
    capabilities,
    createTranslator: (init: { threadId: ThreadId; rootKey: Key }) => new OpenCodeTranslator(init),
    async openSession(ctx: SessionContext) {
      if (!ctx.env) return OpenCodeSession.open(ctx, server);
      if (instances.size >= 128) throw new Error("OpenCode instance limit reached");
      const isolated = new OpenCodeServer({
        ...options,
        discovery: { ...options.discovery, env: ctx.env },
      });
      const onAbort = () => {
        instances.delete(isolated);
        void isolated.close();
      };
      instances.add(isolated);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const session = await OpenCodeSession.open(ctx, isolated);
        return {
          ...session,
          ...(ctx.instanceId === undefined ? {} : { instanceId: ctx.instanceId }),
          get nativeSessionId() {
            return session.nativeSessionId;
          },
          send: (input, delivery, commandId) => session.send(input, delivery, commandId),
          interrupt: (target) => session.interrupt(target),
          resolve: (interaction, resolution) => session.resolve(interaction, resolution),
          stopTask: (task) => session.stopTask(task),
          async close(reason) {
            await session.close(reason);
            ctx.signal.removeEventListener("abort", onAbort);
            instances.delete(isolated);
            await isolated.close();
          },
        };
      } catch (error) {
        ctx.signal.removeEventListener("abort", onAbort);
        instances.delete(isolated);
        await isolated.close();
        throw error;
      }
    },
    async close() {
      await Promise.all([server.close(), ...[...instances].map((instance) => instance.close())]);
      instances.clear();
    },
  };
}
export const opencodeAdapter = createOpenCodeAdapter();

export const adapter = opencodeAdapter;

export { discoverOpenCodeModels } from "./metadata.ts";

export { SessionOwnership } from "./ownership.ts";
