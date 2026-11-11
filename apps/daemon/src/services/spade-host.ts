import { join } from "node:path";
import { AccessMode, ProviderKind, type ThreadId } from "@ace/protocol";
import { ProjectStorage } from "../project-storage.ts";
import {
  ensureSpadeHostThread,
  findHostThread,
  type SpadeHostThread,
} from "../spade/host-thread.ts";
import type { SpadeLink } from "../spade/link.ts";
import type { ServiceContext } from "./types.ts";

/** How long a burst of writes settles before the host thread's busy flag is read again. */
const busySettleMs = 100;

/**
 * Spade's host thread (ADR 0121, kept by ADR 0123): made or healed when Spade's grant is made,
 * following the person's default access and provider, and reported in `spade.status` with
 * whether its tree is busy, whether or not Spade runs.
 */
export function spadeHostThread(
  context: ServiceContext,
  link: Pick<SpadeLink, "setThread">,
  dataDir: string,
) {
  const { services, store } = context;
  let tracked: ThreadId | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    timer = undefined;
    if (!tracked) return;
    const live = services.agentControl?.delegations.journal.liveDescendants(tracked) ?? [];
    link.setThread({ id: tracked, busy: live.length > 0 });
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

  let thread: SpadeHostThread | undefined = existing;
  return {
    /** The host thread now, for the grant's lease; undefined while it is missing. */
    current(): SpadeHostThread | undefined {
      const held = thread && store.getThread(thread.threadId);
      if (held && held.deletedAt === undefined) return thread;
      thread = findHostThread(store);
      return thread;
    },
    /** Finds or makes the host thread with the person's current defaults. */
    async ensure(): Promise<SpadeHostThread | undefined> {
      const { engine } = services;
      if (!engine) {
        context.log.log("warn", "Spade's host thread waits for the engine");
        return undefined;
      }
      const provider = (await services.settings?.get("providers.default"))?.value ?? "claude";
      const access = (await services.settings?.get("access.defaultMode"))?.value ?? "auto-review";
      thread = ensureSpadeHostThread({
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
      return thread;
    },
  };
}
