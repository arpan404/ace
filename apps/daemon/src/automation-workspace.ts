import { logError, logFields } from "@ace/diagnostics";
import { z } from "zod";
import { matchesGlob } from "node:path";
import { GitIgnore, SafeRoot } from "@ace/workspace";
import type { WorkspaceChanges } from "@ace/automations";
import type { WalkEntry } from "@ace/files";
import type { EventPayload } from "@ace/files-native";
import { aceFilesIo } from "./files-tool/io.ts";
import { filesErrorCode, type FilesTool } from "./files-tool/tool.ts";
import type { ServiceContext } from "./services/types.ts";

const WorkspacePathRow = z.object({ path: z.string() });
/** Matching paths one trigger remembers; a lost watcher past this cannot be reconciled. */
const snapshotLimit = 100_000;
/** Events one trigger holds while its baseline is read; past this it rescans after instead. */
const bufferLimit = 10_000;

type TriggerChange = { path: string; kind: "created" | "changed" | "deleted" };
type ChangesPayload = Extract<EventPayload, { type: "changes" }>;

/**
 * A path's version for reconciliation: what a file looked like the last time it was read, and a
 * constant for a folder, whose mtime moves whenever anything inside it does.
 */
function version(entry: { type: string; size: number; mtime: number }): string {
  return entry.type === "directory" ? "directory" : `${entry.type}:${entry.size}:${entry.mtime}`;
}

/**
 * Automation file triggers over ace-files' watch (ADR 0178): one checkout watch shared by every
 * automation on that folder, gitignore rules applied as the TypeScript watcher did, and a rescan
 * reconciled against the (path, kind, version) baseline last seen.
 *
 * The baseline is seeded before `onReady`, so the first rescan names real changes instead of
 * inventing a create for every file already there. Everything after that is serialized: a batch
 * that arrives while a rescan walks waits for it, and either side reports a transition only when
 * the version it read differs from the baseline, so a create the watcher saw and a rescan also
 * finds fires once.
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
      /** The baseline: each matching path and the version it had when it was last read. */
      const known = new Map<string, string>();
      let closed = false;
      let stop: (() => Promise<void>) | undefined;
      let ignore: Promise<GitIgnore> | undefined;
      /** Events seen before the baseline exists, replayed once it does. */
      let buffered: EventPayload[] | undefined = [];
      let overflowed = false;
      let tail: Promise<void> = Promise.resolve();
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
        }).catch((error) => context.log.log("error", "Automation file trigger", logError(error)));
      };
      const failure = (error: unknown) => {
        context.log.log("error", "Automation file trigger", logError(error));
      };
      /** One task at a time, in the order the watcher reported it. */
      const run = (task: () => Promise<void>) => {
        const next = tail.then(task);
        tail = next.then(
          () => {},
          () => {},
        );
        pending.add(next);
        // The task reports its own failure here; this only forgets it.
        void next
          .catch(failure)
          .finally(() => pending.delete(next))
          .catch(() => {});
      };
      /** The version the folder holds now, or undefined when the path is gone. */
      const currentVersion = async (tool: FilesTool, path: string): Promise<string | undefined> => {
        try {
          const entry = await tool.run(workspace.path, (client, root) =>
            client.stat(root, path),
          );
          return version({
            type: entry.kind.type,
            size: entry.size,
            mtime: entry.mtimeMs,
          });
        } catch (error) {
          if (filesErrorCode(error) === "NOT_FOUND") return undefined;
          throw error;
        }
      };
      /** Read the matching tree into a baseline, before anything is reported ready. */
      const seed = async (tool: FilesTool) => {
        const seeded = new Map<string, string>();
        let full = false;
        for await (const entry of aceFilesIo(tool).walk(workspace.path, "")) {
          if (entry.ignored || !matches(entry.path)) continue;
          if (seeded.size >= snapshotLimit) {
            full = true;
            break;
          }
          seeded.set(entry.path, version(entry));
        }
        if (closed) return;
        known.clear();
        for (const [path, entry] of seeded) known.set(path, entry);
        if (full) {
          known.clear();
          context.log.log("warn", "Automation baseline exceeded its snapshot; changes may be lost");
        }
      };
      /** One live batch: a version read now decides whether it names a real transition. */
      const batch = async (tool: FilesTool, changes: ChangesPayload["changes"]) => {
        const rules = await ignoring();
        const ignored = await rules.ignored(changes.map((change) => change.path));
        const matched: TriggerChange[] = [];
        for (const change of changes) {
          if (ignored.has(change.path) || !matches(change.path)) continue;
          const before = known.get(change.path);
          if (change.kind === "deleted") {
            if (!before) continue;
            known.delete(change.path);
            matched.push({ path: change.path, kind: "deleted" });
            continue;
          }
          const now = await currentVersion(tool, change.path);
          if (now === undefined) {
            // Gone before it could be read; a delete of a path we knew is still a transition.
            if (before !== undefined) {
              known.delete(change.path);
              matched.push({ path: change.path, kind: "deleted" });
            }
            continue;
          }
          if (before === undefined) matched.push({ path: change.path, kind: "created" });
          else if (before !== now) matched.push({ path: change.path, kind: "changed" });
          if (!known.has(change.path) && known.size >= snapshotLimit) continue;
          known.set(change.path, now);
        }
        fire(matched);
      };
      /** A rescan names no paths: compare the versions now with the ones last read. */
      const rescan = async (tool: FilesTool) => {
        const current = new Map<string, string>();
        let full = false;
        for await (const entry of aceFilesIo(tool).walk(workspace.path, "")) {
          if (entry.ignored || !matches(entry.path)) continue;
          if (current.size >= snapshotLimit) {
            full = true;
            break;
          }
          current.set(entry.path, version(entry));
        }
        if (closed) return;
        if (full) {
          known.clear();
          context.log.log("warn", "Automation rescan exceeded its snapshot; changes were lost");
          return;
        }
        const changes: TriggerChange[] = [];
        for (const [path, now] of current) {
          const before = known.get(path);
          if (before === undefined) changes.push({ path, kind: "created" });
          else if (before !== now) changes.push({ path, kind: "changed" });
        }
        for (const path of known.keys()) if (!current.has(path)) changes.push({ path, kind: "deleted" });
        known.clear();
        for (const [path, now] of current) known.set(path, now);
        fire(changes);
      };
      const receivePayload = (tool: FilesTool, payload: EventPayload) => {
        if (payload.type === "changes") run(() => batch(tool, payload.changes));
        else if (payload.type === "rescan") run(() => rescan(tool));
        else if (payload.type === "warning")
          context.log.log(
            "warn",
            "Automation workspace watcher",
            logFields([["message", payload.message]]),
          );
      };
      const opening = (async () => {
        const tool = context.services.filesNative?.tool;
        if (!tool) throw new Error("ace-files is unavailable");
        const unsubscribe = await tool.watch(workspace.path, (payload) => {
          if (closed) return;
          if (buffered) {
            if (buffered.length >= bufferLimit) {
              buffered = [];
              overflowed = true;
            } else buffered.push(payload);
            return;
          }
          receivePayload(tool, payload);
        });
        if (closed) {
          await unsubscribe();
          return;
        }
        stop = unsubscribe;
        await seed(tool);
        if (closed) return;
        const replay = buffered ?? [];
        buffered = undefined;
        hooks?.onReady?.();
        if (overflowed) run(() => rescan(tool));
        else for (const payload of replay) receivePayload(tool, payload);
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
