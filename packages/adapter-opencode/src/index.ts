import type { Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { SessionContext, ProviderAdapter } from "@ace/engine-api";
import { capabilities } from "./capabilities.ts";
export { capabilities } from "./capabilities.ts";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { OpenCodeSession } from "./session.ts";
import { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeServer } from "./server.ts";
export function createOpenCodeAdapter(
  options: ServerOptions = {},
): ProviderAdapter & { close(): Promise<void> } {
  const server = new OpenCodeServer(options);
  return {
    provider: "opencode" as const,
    capabilities,
    createTranslator: (init: { threadId: ThreadId; rootKey: Key }) => new OpenCodeTranslator(init),
    openSession: (ctx: SessionContext) => OpenCodeSession.open(ctx, server),
    close: () => server.close(),
  };
}
export const opencodeAdapter = createOpenCodeAdapter();

export const adapter = opencodeAdapter;
