import type { Key } from "@ace/core";
import type { Capabilities, ThreadId } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { SessionContext } from "./contract.ts";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { OpenCodeSession } from "./session.ts";
import { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeTranslator } from "./translator.ts";
export { OpenCodeServer } from "./server.ts";
export function capabilities(cli: DiscoveryResult): Capabilities {
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(cli.version ?? "");
  const supported =
    cli.installed &&
    !!version &&
    (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 18));
  return {
    steer: false,
    interruptCascades: false,
    resume: supported,
    fork: supported,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "partial" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: supported,
  };
}
export function createOpenCodeAdapter(options: ServerOptions = {}) {
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
