import { logError, logFields } from "@ace/diagnostics";
import { z } from "zod";
import { matchesGlob } from "node:path";
import { createWorkspace, type WorkspaceWatcher } from "@ace/workspace";
import type { WorkspaceChanges } from "@ace/automations";
import type { ServiceContext } from "./services/types.ts";

/** Reuse the bounded workspace watcher; each admitted observation has a persisted run key. */
export function automationWorkspace(context: ServiceContext): WorkspaceChanges {
  let subscriptions = 0;
  const pending = new Set<Promise<void>>();
  context.resources.own(async () => {
    await Promise.allSettled(pending);
  });
  return {
    subscribe(root, paths, receive) {
      const row = context.store.atomic((db) =>
        db.prepare("SELECT path FROM workspaces WHERE path=? OR id=? LIMIT 1").get(root, root),
      );
      const workspace = row ? z.object({ path: z.string() }).parse(row) : undefined;
      if (!workspace) throw new Error("automation_workspace_not_found");
      if (subscriptions >= 32) throw new Error("automation_watch_limit");
      subscriptions++;
      let closed = false;
      let watcher: WorkspaceWatcher | undefined;
      const opening = createWorkspace(workspace.path)
        .then(async (owner) => {
          if (closed) return;
          const created = await owner.watch({
            onWarning: (message) =>
              context.log.log(
                "warn",
                "Automation workspace watcher",
                logFields([["message", message]]),
              ),
            onChange(changes) {
              if (closed) return;
              // The watcher bounds its batch; no copy or queue of outstanding batches is kept here.
              const matched: string[] = [];
              let count = 0,
                kind = "changed";
              for (const change of changes) {
                if (!paths.some((path) => matchesGlob(change.path, path))) continue;
                count++;
                if (matched.length < 8) {
                  matched.push(change.path.slice(0, 512));
                  kind = change.kind;
                }
              }
              if (count)
                void receive({
                  key: `file:${context.id()}`,
                  variables: {
                    path: matched[0] ?? "",
                    paths: matched.join("\n"),
                    kind,
                    count: String(count),
                  },
                }).catch((error) =>
                  context.log.log("error", "Automation file trigger", logError(error)),
                );
            },
          });
          if (closed) await created.dispose();
          else watcher = created;
        })
        .catch((error) =>
          context.log.log("error", "Automation watcher unavailable", logError(error)),
        );
      pending.add(opening);
      void opening.finally(() => pending.delete(opening));
      return () => {
        if (closed) return;
        closed = true;
        const disposing = opening
          .then(() => watcher?.dispose())
          .catch((error) =>
            context.log.log("error", "Automation watcher shutdown", logError(error)),
          );
        pending.add(disposing);
        void disposing.finally(() => {
          pending.delete(disposing);
          subscriptions--;
        });
      };
    },
  };
}
