import {
  ThreadId as importThreadId,
  ItemId as importItemId,
  AgentId as importAgentId,
} from "@ace/protocol";
import { localScreenManager, screenConnection, type Simulators } from "@ace/screen";
import { join } from "node:path";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startScreen({
  config,
  options,
  resources,
  services,
  store,
  now,
  id,
}: ServiceContext) {
  const manager =
    options.screen ??
    (config.screenHelper
      ? localScreenManager(config.screenHelper, join(config.dataDir, "screen-artifacts"), {
          manifest: config.screenHelperManifest,
          inheritResponsibility: config.screenHelperInheritsResponsibility,
        })
      : undefined);
  if (manager) {
    const [{ ScreenGrants }, { ScreenApprovals }] = await Promise.all([
      import("../screen-grants.ts"),
      import("../screen-approvals.ts"),
    ]);
    const grants = new ScreenGrants(store, now, (threadId) =>
      services.engine?.screenTurn(importThreadId.parse(threadId)),
    );
    const approvals = new ScreenApprovals({
      store,
      grants,
      now,
      id,
      engine: () => services.engine,
    });
    manager.configureAccess({
      enabled: () => grants.enabled(),
      enable: (enabled) => grants.enable(enabled),
      list: (threadId) => grants.list(threadId),
      allows: (bundleId, scope) => grants.allows(bundleId, scope),
      approve: (bundleId, allowed, scope, threadId) =>
        grants.approve(bundleId, allowed, scope, threadId),
      request: (bundleId, reason, caller, signal) =>
        approvals.request(bundleId, reason, caller, signal),
      foreground: (state, reason, signal) => approvals.foreground(state, signal, reason),
      audit(state, action, outcome) {
        if (!state.holder) return;
        const threadId = importThreadId.parse(state.holder.threadId);
        if (!store.getThread(threadId)) return;
        store.appendEvents(
          threadId,
          [
            {
              type: "item.created",
              item: {
                type: "notice",
                id: importItemId.parse(id()),
                agentId: importAgentId.parse(state.holder.agentId),
                createdAt: now(),
                complete: true,
                level: outcome === "completed" ? "info" : "warning",
                code: "screen.step",
                text: `${action} · ${state.target.kind === "display" ? "display" : state.target.bundleId} · ${state.mode} · ${outcome}`,
                raw: [
                  {
                    type: "ace.screen.step",
                    data: { sessionId: state.sessionId, action, mode: state.mode, outcome },
                  },
                ],
              },
            },
          ],
          now(),
        );
      },
    });
    services.screenApprovals = approvals;
    resources.own(() => approvals.close());
    resources.onShutdown(() => approvals.close());
    resources.own(
      store.subscribe((events) => {
        if (
          events.some(
            (event) =>
              event.payload.type === "run.ended" ||
              event.payload.type === "run.started" ||
              event.payload.type === "thread.client.updated" ||
              (event.payload.type === "thread.updated" && event.payload.status !== undefined),
          )
        )
          void manager.revalidate().catch(() => {});
      }),
    );
    resources.own(() => manager.close());
    services.screen = manager;
  }
}
export function createScreenSession(context: SocketContext, simulators: Simulators): SocketService {
  let channel: ReturnType<typeof screenConnection> | undefined;
  return {
    authenticated(kind) {
      // Screen state belongs on the main and screen channels; a devices channel can't parse it.
      if (kind !== undefined && kind !== "screen") return;
      if (!context.options.screen || !context.authorize("admin")) return;
      channel = screenConnection(context.options.screen, simulators, context.sessionId, {
        send: context.send,
        frame: (packet) =>
          new Promise<void>((resolve, reject) => {
            if (!context.connected() || !context.authorize("admin")) {
              reject(new Error("Socket closed or revoked"));
              return;
            }
            if (context.socket.bufferedAmount > 8 * 1024 * 1024) {
              context.socket.close(4009, "Screen backpressure");
              reject(new Error("Socket backpressure"));
              return;
            }
            context.socket.send(packet, { binary: true }, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      });
    },
    close() {
      channel?.close();
    },
    handle(message) {
      if (message.type !== "screen.request") return false;
      if (!context.authorize("admin"))
        context.fail("forbidden", "Admin scope required for screen access");
      else if (!channel) context.fail("screen_disabled", "Screen capability is not configured");
      else {
        const task = channel
          .request(message)
          .catch((error: unknown) => {
            context.options.log?.(error);
            context.fail("screen_failed", "Screen request failed");
          })
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
}
