import { realpath } from "node:fs/promises";
import type { ClientMessage } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

type Request = Extract<ClientMessage, { type: "catalog.list" }>;
/** Request IDs also identify bounded subscriptions. Every push rechecks current read authority. */
export function createCatalogSession(context: SocketContext): SocketService {
  const stops = new Map<string, () => void>();
  async function read(request: Request) {
    if (!context.connected() || !context.authorize("read")) throw new Error("forbidden");
    const service = context.options.commands;
    if (!service) throw new Error("catalog_unavailable");
    if (request.threadId) {
      if (
        !context.canReadThread(request.threadId) ||
        !context.options.store.getThread(request.threadId)
      )
        throw new Error("read_denied");
      if (!service.listCatalog) throw new Error("catalog_unavailable");
      return service.listCatalog(request.threadId, request.query, request.limit);
    }
    if (request.workspace) {
      const { workspaceId, provider, instanceId } = request.workspace;
      const workspace = context.options.store.getWorkspacePath(workspaceId);
      if (!workspace || !service.listCatalogWorkspace) throw new Error("catalog_unavailable");
      return service.listCatalogWorkspace(
        { workspace: await realpath(workspace), provider, instance: instanceId ?? provider },
        request.query,
        request.limit,
      );
    }
    const draft = request.draft;
    const device = context.device();
    if (!draft || !device || !context.options.context?.draftWorkspace || !service.listCatalogDraft)
      throw new Error("draft_unavailable");
    const root = await context.options.context.draftWorkspace(device, draft.draftId);
    const workspace = context.options.store.getWorkspacePath(draft.workspaceId);
    if (!workspace || (await realpath(workspace)) !== root) throw new Error("draft_unavailable");
    return service.listCatalogDraft(
      draft.draftId,
      { workspace: root, provider: draft.provider, instance: draft.instanceId ?? draft.provider },
      request.query,
      request.limit,
    );
  }
  async function authorized(request: Request): Promise<boolean> {
    if (!context.connected() || !context.authorize("read")) return false;
    if (request.threadId)
      return (
        context.canReadThread(request.threadId) &&
        Boolean(context.options.store.getThread(request.threadId))
      );
    if (request.workspace)
      return Boolean(context.options.store.getWorkspacePath(request.workspace.workspaceId));
    const draft = request.draft,
      device = context.device();
    if (!draft || !device || !context.options.context?.draftWorkspace) return false;
    const root = await context.options.context.draftWorkspace(device, draft.draftId);
    const workspace = context.options.store.getWorkspacePath(draft.workspaceId);
    return Boolean(
      workspace &&
      (await realpath(workspace)) === root &&
      context.connected() &&
      context.authorize("read"),
    );
  }
  return {
    close() {
      for (const stop of stops.values()) stop();
      stops.clear();
    },
    async handle(message) {
      if (message.type === "catalog.unsubscribe") {
        stops.get(message.requestId)?.();
        stops.delete(message.requestId);
        return true;
      }
      if (message.type !== "catalog.list") return false;
      const request = message;
      stops.get(request.requestId)?.();
      stops.delete(request.requestId);
      let stopped = false;
      let running = false;
      let dirty = false;
      let previous = "";
      let stopWatching: (() => void) | undefined;
      const stop = () => {
        stopped = true;
        stopWatching?.();
      };
      const push = async () => {
        if (stopped) return;
        if (running) {
          dirty = true;
          return;
        }
        running = true;
        try {
          do {
            dirty = false;
            const result = await read(request);
            const encoded = JSON.stringify(result);
            // read again to catch deletion/revocation during I/O, without trusting saved authority.
            if (stopped || !(await authorized(request))) return;
            if (encoded !== previous) {
              previous = encoded;
              context.send({ type: "catalog.changed", requestId: request.requestId, ...result });
            }
          } while (dirty);
        } catch {
          stop();
          stops.delete(request.requestId);
        } finally {
          running = false;
        }
      };
      try {
        if (request.subscribe) {
          if (stops.size >= 8 || !context.options.commands?.subscribeCatalog)
            throw new Error("catalog_subscription_limit");
          // Watch before the initial read so discovery cannot race subscription registration.
          running = true;
          stopWatching = context.options.commands.subscribeCatalog(() => {
            void push();
          });
          stops.set(request.requestId, stop);
        }
        const result = await read(request);
        if (stopped || !(await authorized(request))) throw new Error("read_denied");
        previous = JSON.stringify(result);
        context.send({ type: "catalog.list.result", requestId: request.requestId, ...result });
        running = false;
        if (request.subscribe && (dirty || result.stale)) void push();
      } catch {
        stop();
        stops.delete(request.requestId);
        context.fail("catalog_unavailable", "Catalog or context unavailable", false, {
          requestId: request.requestId,
        });
      }
      return true;
    },
  };
}
