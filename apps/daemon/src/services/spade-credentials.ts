import { join } from "node:path";
import { AccessMode, ProviderKind, type ThreadId } from "@ace/protocol";
import { loadToken } from "../local-files.ts";
import { ProjectStorage } from "../project-storage.ts";
import type { SpadeCredentials, SpadeHost } from "../spade/host.ts";
import { ensureSpadeHostThread, findHostThread } from "../spade/host-thread.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ServiceContext } from "./types.ts";

/** How long a burst of writes settles before the host thread's busy flag is read again. */
const busySettleMs = 100;

/**
 * What each Spade run is given (ADR 0117): the daemon's socket and local token, and an MCP lease
 * on the daemon's own endpoint naming Spade's host thread and its root agent, with the tool
 * groups a provider session gets. The host thread is found or made first, so it heals on every
 * start. Also keeps `spade.status` saying whether the host thread's tree is busy.
 */
export function spadeCredentials(
  context: ServiceContext,
  host: SpadeHost,
  dataDir: string,
  daemonUrl: () => string | undefined,
): () => Promise<SpadeCredentials> {
  const { services, store } = context;
  let tracked: ThreadId | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    timer = undefined;
    if (!tracked) return;
    const live = services.agentControl?.delegations.journal.liveDescendants(tracked) ?? [];
    host.setThread({ id: tracked, busy: live.length > 0 });
  };
  const stopWrites = store.onWrite(() => {
    if (!tracked || timer) return;
    timer = setTimeout(refresh, busySettleMs);
    timer.unref?.();
  });
  context.resources.own(() => {
    stopWrites();
    clearTimeout(timer);
  }, "spade host thread status");
  // The host thread's access and provider are the person's defaults: a change applies to
  // Spade's next delegation at once, with the same thread, lease and delegation receipts.
  const settings = services.settings;
  if (settings)
    void settings
      .subscribe(
        { keys: ["access.defaultMode", "providers.default"], scope: {} },
        (notification) => {
          if (notification.type !== "changed" || !tracked) return;
          const hosts = services.engine?.hosts;
          for (const entry of notification.entries) {
            const access = AccessMode.safeParse(entry.value);
            const provider = ProviderKind.safeParse(entry.value);
            if (entry.key === "access.defaultMode" && access.success)
              hosts?.setAccess(tracked, access.data);
            if (entry.key === "providers.default" && provider.success)
              hosts?.setProvider(tracked, provider.data);
          }
        },
      )
      .then(
        (stop) => context.resources.own(stop, "spade host thread access"),
        (error: unknown) =>
          context.log.log("warn", "Spade's host thread won't follow default changes", {
            error: error instanceof Error ? error.message : String(error),
          }),
      );

  // The host thread is reported from the start, whether or not Spade runs, so the apps know
  // Spade's children by their parent even with Spade off or not installed.
  const existing = findHostThread(store);
  if (existing) {
    tracked = existing.threadId;
    refresh();
  }

  return async () => {
    const issued: Record<string, string> = {};
    const url = daemonUrl();
    if (url) {
      issued.SPADE_ACE_URL = url;
      issued.SPADE_ACE_TOKEN = loadToken(context.config.dataDir).token;
    }
    const { mcp, engine } = services;
    if (!mcp || !engine) {
      context.log.log("warn", "Spade starts without ace's tools: the MCP server is unavailable");
      return { env: issued, revoke: () => {} };
    }
    const provider = (await services.settings?.get("providers.default"))?.value ?? "claude";
    const access = (await services.settings?.get("access.defaultMode"))?.value ?? "auto-review";
    const thread = ensureSpadeHostThread({
      store,
      engine,
      catalog: services.projects?.catalog ?? new ProjectStorage(store, context.now),
      folder: join(dataDir, "workspace"),
      provider,
      access,
      id: context.id,
    });
    tracked = thread.threadId;
    refresh();
    const lifetime = new AbortController();
    const lease = mcp.openSession(
      {
        sessionId: `spade:${context.id()}`,
        threadId: thread.threadId,
        agentId: thread.agentId,
        capabilities: daemonMcpCapabilities(services),
      },
      lifetime.signal,
    );
    issued.SPADE_ACE_MCP_URL = mcp.url;
    issued.SPADE_ACE_MCP_TOKEN = lease.bearer;
    return {
      env: issued,
      revoke: () => {
        lease.end();
        lifetime.abort();
      },
    };
  };
}
