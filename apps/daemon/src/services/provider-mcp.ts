import { rm } from "node:fs/promises";
import { createBuiltinSkillRoot } from "../builtin-skill-roots.ts";
import { prepareBuiltinSkills } from "@ace/plugins";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { bindMcpSession } from "./mcp-session.ts";
import type { ServiceContext } from "./types.ts";

/** All providers share scoped authority and cleanup; adapters encode their native MCP config. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id"> &
    Partial<Pick<ServiceContext, "config">>,
  adapter: ProviderAdapter,
): ProviderAdapter {
  if (adapter.backend === "cursor-sdk") return adapter;
  return {
    ...adapter,
    async openSession(session) {
      const mcp = context.services.mcp;
      if (adapter.provider === "pi" && !mcp && !session.aceMcp && !session.mcp)
        return adapter.openSession(session);
      if (!mcp && !session.aceMcp && !session.mcp)
        throw new Error("Provider MCP scope unavailable");
      let skills: Awaited<ReturnType<typeof prepareBuiltinSkills>> | undefined;
      let root: string | undefined;
      if (context.config && (adapter.provider === "claude" || adapter.provider === "codex")) {
        root = await createBuiltinSkillRoot(context.config.dataDir);
        try {
          skills = await prepareBuiltinSkills(adapter.provider, root);
        } catch (error) {
          await rm(root, { recursive: true, force: true });
          throw error;
        }
      }
      let cleanup: Promise<void> | undefined;
      const closeSkills = () =>
        (cleanup ??= (async () => {
          await skills?.close();
          if (root) await rm(root, { recursive: true, force: true });
        })());
      try {
        const opened = await bindMcpSession(
          adapter,
          {
            ...session,
            ...(skills
              ? { builtinSkills: { args: skills.args, directories: skills.directories } }
              : {}),
            onExit(exit) {
              void closeSkills().catch(() => {});
              session.onExit(exit);
            },
          },
          {
            mcp,
            store: context.store,
            id: context.id,
            capabilities: daemonMcpCapabilities(context.services),
            onEnd(threadId, agentId) {
              releaseMcpControllers(context.services, threadId, agentId);
            },
          },
        );
        const close = opened.close.bind(opened);
        opened.close = async (reason) => {
          await close(reason);
          await closeSkills();
        };
        return opened;
      } catch (error) {
        await closeSkills();
        throw error;
      }
    },
  };
}

/** Shared by CLI leases and Cursor's independently owned SDK lease. */
export function releaseMcpControllers(
  services: ServiceContext["services"],
  threadId: string,
  agentId: string,
): void {
  const owner = JSON.stringify([threadId, agentId]);
  services.devices?.disconnect(owner);
  services.screen?.releaseController(owner);
}
