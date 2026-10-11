import {
  SettingsError,
  validateAssignment,
  type SettingsService,
  type Scope,
  type Layer,
} from "@ace/settings";
import {
  type SettingsRequest,
  type SettingsScope,
  type ServerMessage,
  type SettingsEntry,
  type SettingsDiagnostic,
  SettingsProvenance,
  SettingsKey,
  SettingsValues,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { canonicalProjectRoots } from "./project-policy.ts";

export function settingsScope(store: Store, scope: SettingsScope): Scope {
  let workspaceId = scope.workspaceId;
  if (scope.threadId) {
    const thread = store.getThread(scope.threadId);
    if (!thread || (workspaceId && workspaceId !== thread.workspaceId))
      throw new SettingsError("validation", "Unknown thread or mismatched workspace");
    workspaceId = thread.workspaceId;
  }
  const workspace = workspaceId ? store.getWorkspacePath(workspaceId) : undefined;
  if (workspaceId && !workspace) throw new SettingsError("validation", "Unknown workspace");
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(scope.threadId ? { thread: scope.threadId } : {}),
  };
}
export function settingsSession(options: {
  service: SettingsService | undefined;
  store: Store;
  subscriptions: Map<string, () => void>;
  send(message: ServerMessage): void;
  authorize?(request: SettingsRequest): boolean;
  resetKeys?(): SettingsKey[];
  set?(key: string, value: unknown, commit: () => Promise<void>): Promise<void>;
}) {
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  function error(request: SettingsRequest, reason: unknown): void {
    const known =
      reason instanceof SettingsError
        ? reason
        : new SettingsError("io", "Settings operation failed");
    const layer = request.type === "settings.set" ? request.layer.kind : "global";
    options.send({
      type: "settings.result",
      requestId: request.requestId,
      ok: false,
      entries: [],
      diagnostics: [
        { layer: SettingsProvenance.parse(layer), code: known.code, message: known.message },
      ],
    });
  }
  return {
    accept(request: SettingsRequest): void {
      if (closed) return;
      if (request.type === "settings.unsubscribe") {
        if (options.authorize && !options.authorize(request)) {
          error(request, new SettingsError("validation", "Device authority changed"));
          return;
        }
        options.subscriptions.get(request.subscriptionId)?.();
        options.subscriptions.delete(request.subscriptionId);
        options.send({
          type: "settings.result",
          requestId: request.requestId,
          ok: true,
          entries: [],
          diagnostics: [],
        });
        return;
      }
      if (pending >= 64) {
        error(request, new SettingsError("limit", "Settings request queue is full"));
        return;
      }
      const reservation = { cancelled: false, stop: () => {} };
      if (request.type === "settings.subscribe") {
        options.subscriptions.get(request.subscriptionId)?.();
        options.subscriptions.delete(request.subscriptionId);
        if (options.subscriptions.size >= 64) {
          error(request, new SettingsError("limit", "Too many subscriptions"));
          return;
        }
        options.subscriptions.set(request.subscriptionId, () => {
          reservation.cancelled = true;
          reservation.stop();
        });
      }
      pending++;
      tail = tail
        .then(async () => {
          if (closed || reservation.cancelled) return;
          if (options.authorize && !options.authorize(request))
            throw new SettingsError("validation", "Device authority changed");
          const service = options.service;
          if (!service) throw new SettingsError("io", "Settings service is unavailable");
          if (request.type === "settings.reset") {
            await service.reset(options.resetKeys?.() ?? []);
            options.send({
              type: "settings.result",
              requestId: request.requestId,
              ok: true,
              entries: [],
              diagnostics: [],
            });
            return;
          }
          const wireScope =
            request.type === "settings.set"
              ? request.layer.kind === "global"
                ? {}
                : request.layer.kind === "workspace"
                  ? { workspaceId: request.layer.workspaceId }
                  : { threadId: request.layer.threadId }
              : request.scope;
          const scope = settingsScope(options.store, wireScope);
          if (request.type === "settings.set") {
            if (request.key === "browser.allowedOrigins" && request.layer.kind !== "global")
              throw new SettingsError("validation", "Browser allowlist is a global user setting");
            const layer: Layer =
              request.layer.kind === "global"
                ? { kind: "global" }
                : request.layer.kind === "workspace" && scope.workspace
                  ? { kind: "workspace", workspace: scope.workspace }
                  : request.layer.kind === "thread"
                    ? { kind: "thread", thread: request.layer.threadId }
                    : { kind: "global" };
            // Validation remains in the service, including recursive secret checks.
            const assignment = validateAssignment(request.key, request.value);
            let value = assignment.value;
            if (assignment.key === "projects.roots") {
              try {
                value = await canonicalProjectRoots(
                  SettingsValues.shape["projects.roots"].parse(value),
                );
              } catch {
                throw new SettingsError(
                  "validation",
                  "Choose an existing, accessible project folder outside system folders",
                );
              }
            }
            const commit = async () => {
              await service.set(assignment.key, value, layer);
            };
            if (options.set) await options.set(assignment.key, value, commit);
            else await commit();
          }
          const selector = {
            keys:
              request.type === "settings.subscribe"
                ? request.keys
                : [SettingsKey.parse(request.key)],
            scope,
          };
          let initial = true;
          const buffered = new Map<string, SettingsEntry>();
          const diagnostics = new Map<string, SettingsDiagnostic>();
          if (request.type === "settings.subscribe") {
            reservation.stop = await service.subscribe(selector, (notification) => {
              if (closed || reservation.cancelled) return;
              if (initial) {
                if (notification.type === "changed")
                  for (const entry of notification.entries) buffered.set(entry.key, entry);
                else diagnostics.set(notification.diagnostic.layer, notification.diagnostic);
                return;
              }
              if (notification.type === "changed")
                options.send({
                  type: "settings.changed",
                  subscriptionId: request.subscriptionId,
                  entries: notification.entries,
                });
              else
                options.send({
                  type: "settings.diagnostic",
                  subscriptionId: request.subscriptionId,
                  diagnostic: notification.diagnostic,
                });
            });
            if (closed || reservation.cancelled) {
              reservation.stop();
              return;
            }
          }
          const result = await service.read(selector);
          if (closed || reservation.cancelled) return;
          options.send({
            type: "settings.result",
            requestId: request.requestId,
            ok: true,
            ...result,
          });
          initial = false;
          if (request.type === "settings.subscribe") {
            if (buffered.size)
              options.send({
                type: "settings.changed",
                subscriptionId: request.subscriptionId,
                entries: [...buffered.values()],
              });
            for (const diagnostic of diagnostics.values())
              options.send({
                type: "settings.diagnostic",
                subscriptionId: request.subscriptionId,
                diagnostic,
              });
            buffered.clear();
            diagnostics.clear();
          }
        })
        .catch((reason: unknown) => {
          if (request.type === "settings.subscribe" && !reservation.cancelled) {
            reservation.stop();
            options.subscriptions.delete(request.subscriptionId);
          }
          if (!closed) error(request, reason);
        })
        .finally(() => {
          pending--;
        });
    },
    drained: () => tail,
    close() {
      closed = true;
    },
  };
}
