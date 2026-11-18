import { logError, logFields } from "@ace/diagnostics";
import { z } from "zod";
import { matchesGlob } from "node:path";
import { GitIgnore, SafeRoot } from "@ace/workspace";
import type { WorkspaceChanges } from "@ace/automations";
import type { EventPayload } from "@ace/files-native";
import { aceFilesIo } from "./files-tool/io.ts";
import type { FilesTool } from "./files-tool/tool.ts";
import type { ServiceContext } from "./services/types.ts";

const WorkspacePathRow = z.object({ path: z.string() });
/** Matching paths one trigger remembers; a lost watcher past this cannot be reconciled. */
const snapshotLimit = 100_000;

type TriggerChange = { path: string; kind: "created" | "changed" | "deleted" };

/**
 * Automation file triggers over ace-files' watch (ADR 0178): one checkout watch shared by every
 * automation on that folder, gitignore rules applied as the TypeScript watcher did, and a rescan
 * reconciled against the matching paths last seen.
 */
export function automationWorkspace(context: ServiceContext): WorkspaceChanges {
  let subscriptions = 0;
  const pending = new Set<Promise<void>>();
  context.resources.own(async () => {
    await Promise.allSettled(pending);
  });
  return {
    subscribe(root, patterns, receive, hooks) {
      const row = context.store.atomic((db) =>
        db.prepare("SELECT path FROM workspaces WHERE path=? OR id=? LIMIT 1").get(root, root),
      );
      const workspace = row ? WorkspacePathRow.parse(row) : undefined;
      if (!workspace) {
        const error = new Error("automation_workspace_not_found");
        hooks?.onError?.(error);
        throw error;
      }
      if (subscriptions >= 256) {
        const error = new Error("automation_watch_limit");
        hooks?.onError?.(error);
        throw error;
      }
      subscriptions++;
      const matches = (path: string) => patterns.some((pattern) => matchesGlob(path, pattern));
      const known = new Set<string>();
      let closed = false;
      let stop: (() => Promise<void>) | undefined;
      let ignore: Promise<GitIgnore> | undefined;
      const ignoring = () => {
        ignore ??= SafeRoot.create(workspace.path).then((safe) => GitIgnore.create(safe));
        return ignore;
      };
      const fire = (changes: readonly TriggerChange[]) => {
        if (closed || !changes.length) return;
        const matched = changes.slice(0, 8).map((change) => change.path.slice(0, 512));
        const kind = changes[0]?.kind ?? "changed";
        void receive({
          key: `file:${context.id()}`,
          variables: {
            path: matched[0] ?? "",
            paths: matched.join("\n"),
            kind,
            count: String(changes.length),
          },
        }).catch((error) =>
          context.log.log("error", "Automation file trigger", logError(error)),
        );
      };
      /** A rescan names no paths: compare the matching paths now with the ones last seen. */
      const rescan = async (tool: FilesTool) => {
        const current = new Set<string>();
        let full = false;
        for await (const entry of aceFilesIo(tool).walk(workspace.path, "")) {
          if (entry.ignored || !matches(entry.path)) continue;
          if (current.size >= snapshotLimit) {
            full = true;
            break;
          }
          current.add(entry.path);
        }
        if (closed) return;
        if (full) {
          known.clear();
          context.log.log("warn", "Automation rescan exceeded its snapshot; changes were lost");
          return;
        }
        const changes: TriggerChange[] = [];
        for (const path of current) if (!known.has(path)) changes.push({ path, kind: "created" });
        for (const path of known) if (!current.has(path)) changes.push({ path, kind: "deleted" });
        known.clear();
        for (const path of current) known.add(path);
        fire(changes);
      };
      const batch = async (changes: Extract<EventPayload, { type: "changes" }>["changes"]) => {
        const rules = await ignoring();
        const ignored = await rules.ignored(changes.map((change) => change.path));
        const matched: TriggerChange[] = [];
        for (const change of changes) {
          if (ignored.has(change.path) || !matches(change.path)) continue;
          if (change.kind === "deleted") known.delete(change.path);
          else if (known.size < snapshotLimit) known.add(change.path);
          matched.push({
            path: change.path,
            kind: change.kind === "modified" ? "changed" : change.kind,
          });
        }
        fire(matched);
      };
      const failure = (error: unknown) => {
        context.log.log("error", "Automation file trigger", logError(error));
      };
      /** A batch or rescan outlives one event; the close waits for whatever is running. */
      const track = (task: Promise<void>) => {
        pending.add(task);
        // The task reports its own failure; this only forgets it.
        void task.catch(failure).finally(() => pending.delete(task));
      };
      const opening = (async () => {
        const tool = context.services.filesNative?.tool;
        if (!tool) throw new Error("ace-files is unavailable");
        const unsubscribe = await tool.watch(workspace.path, (payload) => {
          if (closed) return;
          if (payload.type === "changes") {
            track(batch(payload.changes));
            return;
          }
          if (payload.type === "rescan") {
            track(rescan(tool));
            return;
          }
          if (payload.type === "warning")
            context.log.log(
              "warn",
              "Automation workspace watcher",
              logFields([["message", payload.message]]),
            );
        });
        if (closed) await unsubscribe();
        else {
          stop = unsubscribe;
          hooks?.onReady?.();
        }
      })().catch((error) => {
        context.log.log("error", "Automation watcher unavailable", logError(error));
        hooks?.onError?.(error);
      });
      pending.add(opening);
      // The open reports its own failure above; this only forgets it.
      void opening.finally(() => pending.delete(opening)).catch(() => {});
      return () => {
        if (closed) return;
        closed = true;
        const disposing = opening
          .then(() => stop?.())
          .catch((error) =>
            context.log.log("error", "Automation watcher shutdown", logError(error)),
          );
        pending.add(disposing);
        // The dispose reports its own failure above; this only forgets it.
        void disposing
          .finally(() => {
            pending.delete(disposing);
            subscriptions--;
          })
          .catch(() => {});
      };
    },
  };
}
