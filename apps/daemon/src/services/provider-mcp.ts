import { rm } from "node:fs/promises";
import { createBuiltinSkillRoot } from "../builtin-skill-roots.ts";
import {
  builtinSkillProcessLease,
  builtinSkillRootUnused,
  type BuiltinSkillProcessLease,
} from "../builtin-skill-processes.ts";
import { prepareBuiltinSkills } from "@ace/plugins";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { bindMcpSession } from "./mcp-session.ts";
import { sharedBuiltinSkills } from "../builtin-skill-share.ts";
import type { ServiceContext } from "./types.ts";

/** All providers share scoped authority and cleanup; adapters encode their native MCP config. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id"> &
    Partial<Pick<ServiceContext, "config" | "resources">>,
  adapter: ProviderAdapter,
): ProviderAdapter {
  if (adapter.backend === "cursor-sdk") return adapter;
  // A provider that exits on its own starts skill cleanup outside any close call.
  // Daemon shutdown waits for those removals instead of leaving them running.
  const cleanups = new Set<Promise<void>>();
  // Codex sessions share an app-server, so they share the one projection it was started with.
  const shared =
    adapter.provider === "codex" && context.config
      ? sharedBuiltinSkills("codex", context.config.dataDir)
      : undefined;
  context.resources?.own(async () => {
    await Promise.allSettled(cleanups);
    await shared?.close();
  });
  return {
    ...adapter,
    async openSession(session) {
      const mcp = context.services.mcp;
      if (adapter.provider === "pi" && !mcp && !session.aceMcp && !session.mcp)
        return adapter.openSession(session);
      if (!mcp && !session.aceMcp && !session.mcp)
        throw new Error("Provider MCP scope unavailable");
      let skills:
        | Pick<Awaited<ReturnType<typeof prepareBuiltinSkills>>, "args" | "directories" | "close">
        | undefined;
      let root: string | undefined;
      let lease: Pick<BuiltinSkillProcessLease, "preparing" | "spawned" | "close"> | undefined;
      if (shared) {
        const projection = await shared.acquire();
        skills = { ...projection, close: projection.release };
        lease = { ...projection.lease, close: () => {} };
      } else if (context.config && adapter.provider === "claude") {
        root = await createBuiltinSkillRoot(context.config.dataDir);
        try {
          skills = await prepareBuiltinSkills(adapter.provider, root);
          lease = builtinSkillProcessLease(root);
        } catch (error) {
          await rm(root, { recursive: true, force: true });
          throw error;
        }
      }
      let cleanup: Promise<void> | undefined;
      const closeSkills = () => {
        if (cleanup) return cleanup;
        const started = (async () => {
          lease?.close();
          if (root && !builtinSkillRootUnused(root)) return;
          await skills?.close();
          if (root) await rm(root, { recursive: true, force: true });
        })();
        cleanup = started;
        cleanups.add(started);
        void started.then(
          () => cleanups.delete(started),
          () => cleanups.delete(started),
        );
        return started;
      };
      try {
        const opened = await bindMcpSession(
          adapter,
          {
            ...session,
            ...(skills
              ? {
                  builtinSkills: {
                    args: skills.args,
                    directories: skills.directories,
                    ...(lease ? { lease } : {}),
                  },
                }
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
