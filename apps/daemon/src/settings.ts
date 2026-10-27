import { homedir } from "node:os";
import {
  SettingsError,
  validateAssignment,
  type SettingsService,
  type Scope,
  type Layer,
} from "@ace/settings";
import {
  type SettingsLayer as SettingsLayerWire,
  type SettingsRequest,
  type SettingsScope,
  type ServerMessage,
  type SettingsEntry,
  type SettingsDiagnostic,
  SettingsLayerKind,
  SettingsKey,
  SettingsValues,
} from "@ace/protocol";
import { setOnItsOwn } from "@ace/settings/batch";
import type { Store } from "./store.ts";
import { canonicalProjectRoots } from "./project-policy.ts";
import { canonicalDownloadFolder } from "./download-folder.ts";

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
/** The wire scope a write's layer resolves inheritance in. */
function layerScope(layer: SettingsLayerWire): SettingsScope {
  return layer.kind === "global"
    ? {}
    : layer.kind === "workspace"
      ? { workspaceId: layer.workspaceId }
      : { threadId: layer.threadId };
}
/** The service layer a write lands on; an unknown workspace falls back to global, as before. */
function writeLayer(layer: SettingsLayerWire, scope: Scope): Layer {
  return layer.kind === "global"
    ? { kind: "global" }
    : layer.kind === "workspace" && scope.workspace
      ? { kind: "workspace", workspace: scope.workspace }
      : layer.kind === "thread"
        ? { kind: "thread", thread: layer.threadId }
        : { kind: "global" };
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
    const layer =
      request.type === "settings.set" || request.type === "settings.setMany"
        ? request.layer.kind
        : "global";
    options.send({
      type: "settings.result",
      requestId: request.requestId,
      ok: false,
      entries: [],
      diagnostics: [
        { layer: SettingsLayerKind.parse(layer), code: known.code, message: known.message },
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
          if (request.type === "settings.setMany") {
            const scope = settingsScope(options.store, layerScope(request.layer));
            // Every entry is checked before anything is written: all or none.
            const assignments = request.entries.map((entry) =>
              validateAssignment(entry.key, entry.value),
            );
            const own = assignments.find((assignment) => setOnItsOwn(assignment.key));
            if (own)
              throw new SettingsError("validation", `Set ${own.key} on its own, not with others`);
            await service.setMany(assignments, writeLayer(request.layer, scope));
            const result = await service.read({
              keys: assignments.map((assignment) => assignment.key),
              scope,
            });
            if (closed) return;
            options.send({
              type: "settings.result",
              requestId: request.requestId,
              ok: true,
              ...result,
            });
            return;
          }
          const wireScope =
            request.type === "settings.set" ? layerScope(request.layer) : request.scope;
          const scope = settingsScope(options.store, wireScope);
          if (request.type === "settings.set") {
            const layer = writeLayer(request.layer, scope);
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
            if (assignment.key === "browser.downloadDefault")
              throw new SettingsError(
                "validation",
                "This machine's Downloads folder is read-only; set browser.downloadDir instead",
              );
            if (assignment.key === "browser.downloadDir") {
              try {
                value = await canonicalDownloadFolder(
                  SettingsValues.shape["browser.downloadDir"].parse(value),
                  homedir(),
                );
              } catch (problem) {
                throw new SettingsError(
                  "validation",
                  problem instanceof Error ? problem.message : "Choose a folder ace can write to",
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
