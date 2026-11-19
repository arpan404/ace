import { logError, logFields } from "@ace/diagnostics";
import { z } from "zod";
import { matchesGlob } from "node:path";
import { GitIgnore, SafeRoot } from "@ace/workspace";
import type { WorkspaceChanges } from "@ace/automations";
import type { EventPayload } from "@ace/files-native";
import { aceFilesIo } from "./files-tool/io.ts";
import { filesErrorCode, type FilesTool } from "./files-tool/tool.ts";
import type { ServiceContext } from "./services/types.ts";

const WorkspacePathRow = z.object({ path: z.string() });
/** Matching paths one trigger remembers; a lost watcher past this cannot be reconciled. */
const defaultSnapshotLimit = 100_000;
/** Events one trigger holds while its baseline is read; past this it rescans after instead. */
const defaultBufferLimit = 10_000;

/** What one reconciliation may hold, for tests that cannot build a checkout of 100,000 paths. */
export type AutomationWorkspaceLimits = {
  snapshotLimit: number;
  bufferLimit: number;
};

type TriggerChange = { path: string; kind: "created" | "changed" | "deleted" };
type ChangesPayload = Extract<EventPayload, { type: "changes" }>;

/**
 * The version a listing reports for a path: what a file looked like the last time it was read, and
 * a constant for a folder, whose mtime moves whenever anything inside it does.
 */
function version(entry: { type: string; size: number; mtime: number }): string {
  return entry.type === "directory" ? "directory" : `${entry.type}:${entry.size}:${entry.mtime}`;
}

/**
 * What a path looked like when it was last reconciled: the version above and, for a file, the
 * digest of the bytes that version had.
 *
 * The version names size and times, so an edit that keeps the size and restores the modification
 * time leaves it unchanged. The digest is what tells that edit apart from an untouched file when
 * the watcher was not running.
 */
type Known = { version: string; digest?: string };

/**
 * Automation file triggers over ace-files' watch (ADR 0178): one checkout watch shared by every
 * automation on that folder, gitignore rules applied as the TypeScript watcher did, and a rescan
 * reconciled against the (path, version, content) baseline last seen.
 *
 * The baseline is seeded before `onReady`, so the first rescan names real changes instead of
 * inventing a create for every file already there. Everything after that is serialized: a batch
 * that arrives while a rescan walks waits for it, and either side reports a transition only when
 * the version it read differs from the baseline, so a create the watcher saw and a rescan also
 * finds fires once.
 */
export function automationWorkspace(
  context: ServiceContext,
  limits: AutomationWorkspaceLimits = {
    snapshotLimit: defaultSnapshotLimit,
    bufferLimit: defaultBufferLimit,
  },
): WorkspaceChanges {
  const { snapshotLimit, bufferLimit } = limits;
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
      /** The baseline: each matching path and what it looked like when last reconciled. */
      const known = new Map<string, Known>();
      /**
       * Versions a rescan has already reported, against a live batch that names the same version:
       * that is the only duplicate this watcher has to suppress. A live modification is never
       * dropped because its version happens to equal the baseline.
       */
      let reported = new Map<string, string>();
      /** Whether `known` came from a scan that saw every matching path. */
      let complete = false;
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
      /** The version the folder holds now, and whether it holds a file, or nothing at all. */
      const currentEntry = async (
        tool: FilesTool,
        path: string,
      ): Promise<{ version: string; file: boolean } | undefined> => {
        try {
          const entry = await tool.run(workspace.path, (client, number) =>
            client.stat(number, path),
          );
          return {
            version: version({
              type: entry.kind.type,
              size: entry.size,
              mtime: entry.mtimeMs,
            }),
            file: entry.kind.type === "file",
          };
        } catch (error) {
          if (filesErrorCode(error) === "NOT_FOUND") return undefined;
          throw error;
        }
      };
      /**
       * The content digests of `paths`, hashed in one pass through ace-files. A file that is gone
       * or cannot be read has no digest: its version still decides, and it is hashed again on the
       * next scan.
       */
      const digests = async (
        tool: FilesTool,
        paths: readonly string[],
      ): Promise<Map<string, string>> => {
        const found = new Map<string, string>();
        if (!paths.length) return found;
        await tool.run(workspace.path, async (client, number) => {
          for (const path of paths) {
            try {
              const reply = await client.fingerprint(number, path);
              found.set(path, reply.digest);
            } catch {
              // A file written while it is hashed is a conflict, and one that vanished is a
              // delete the version already shows. Neither may fail the whole reconciliation.
            }
          }
        });
        return found;
      };
      /** Read the matching tree into a baseline, before anything is reported ready. */
      const seed = async (tool: FilesTool) => {
        const seeded = new Map<string, Known>();
        const files: string[] = [];
        let full = false;
        for await (const entry of aceFilesIo(tool).walk(workspace.path, "")) {
          if (entry.ignored || !matches(entry.path)) continue;
          if (seeded.size >= snapshotLimit) {
            full = true;
            break;
          }
          seeded.set(entry.path, { version: version(entry) });
          if (entry.type === "file") files.push(entry.path);
        }
        if (closed) return;
        for (const [path, digest] of await digests(tool, files)) {
          const held = seeded.get(path);
          if (held) held.digest = digest;
        }
        if (closed) return;
        known.clear();
        for (const [path, entry] of seeded) known.set(path, entry);
        complete = !full;
        if (full) {
          known.clear();
          context.log.log("warn", "Automation baseline exceeded its snapshot; changes may be lost");
        }
      };
      /** One live batch: a version read now decides whether it names a real transition. */
      const batch = async (
        tool: FilesTool,
        changes: ChangesPayload["changes"],
        announce = false,
      ) => {
        const rules = await ignoring();
        const ignored = await rules.ignored(changes.map((change) => change.path));
        const matched: TriggerChange[] = [];
        /** The files this batch reports or whose version moved, whose digest it must refresh. */
        const hashed: { path: string; version: string }[] = [];
        for (const change of changes) {
          if (ignored.has(change.path) || !matches(change.path)) continue;
          const before = known.get(change.path);
          if (change.kind === "deleted") {
            if (!before && !announce) continue;
            known.delete(change.path);
            reported.delete(change.path);
            matched.push({ path: change.path, kind: "deleted" });
            continue;
          }
          const now = await currentEntry(tool, change.path);
          if (!now) {
            // Gone before it could be read; a delete of a path we knew is still a transition.
            if (before !== undefined) {
              known.delete(change.path);
              reported.delete(change.path);
              matched.push({ path: change.path, kind: "deleted" });
            }
            continue;
          }
          // A batch held while the baseline was read is newer than that baseline: report what it
          // says once, even when the seed already saw the file it names.
          if (announce) {
            matched.push({
              path: change.path,
              kind: change.kind === "modified" ? "changed" : change.kind,
            });
          } else if (before === undefined)
            matched.push({
              path: change.path,
              kind: change.kind === "modified" ? "changed" : "created",
            });
          else if (before.version !== now.version)
            matched.push({ path: change.path, kind: "changed" });
          else if (reported.get(change.path) === now.version) {
            // The rescan that just walked this checkout reported exactly this version; the live
            // batch that follows it names the same transition.
            reported.delete(change.path);
          } else if (change.kind === "modified") {
            // An explicit live modification, even at a version the baseline already holds: a save
            // that kept the size and restored the mtime is still a change the person made. A
            // watcher's `created` for a path the seed already saw is that file, not a change.
            matched.push({ path: change.path, kind: "changed" });
          }
          if (!known.has(change.path) && known.size >= snapshotLimit) continue;
          if (now.file) hashed.push({ path: change.path, version: now.version });
          known.set(change.path, { version: now.version });
        }
        for (const [path, digest] of await digests(
          tool,
          hashed.map((entry) => entry.path),
        )) {
          const held = known.get(path);
          if (held) held.digest = digest;
        }
        fire(matched);
      };
      /** A rescan names no paths: compare the versions and content now with the baseline. */
      const rescan = async (tool: FilesTool) => {
        const current = new Map<string, Known>();
        const files: string[] = [];
        let full = false;
        for await (const entry of aceFilesIo(tool).walk(workspace.path, "")) {
          if (entry.ignored || !matches(entry.path)) continue;
          if (current.size >= snapshotLimit) {
            full = true;
            break;
          }
          current.set(entry.path, { version: version(entry) });
          if (entry.type === "file") files.push(entry.path);
        }
        if (closed) return;
        if (full) {
          // The scan cannot see everything, so it cannot tell a create from a path that was
          // always there. Keep the last complete baseline; the next complete scan seeds it.
          complete = false;
          context.log.log("warn", "Automation rescan exceeded its snapshot; the baseline was kept");
          return;
        }
        for (const [path, digest] of await digests(tool, files)) {
          const held = current.get(path);
          if (held) held.digest = digest;
        }
        if (closed) return;
        if (!complete) {
          // The previous scan missed paths, so reporting creates now would invent them. Seed the
          // complete baseline silently instead, and report from the scan after this one.
          known.clear();
          for (const [path, entry] of current) known.set(path, entry);
          complete = true;
          return;
        }
        const changes: TriggerChange[] = [];
        for (const [path, now] of current) {
          const before = known.get(path);
          if (before === undefined) changes.push({ path, kind: "created" });
          else if (before.version !== now.version) changes.push({ path, kind: "changed" });
          else if (
            before.digest !== undefined &&
            now.digest !== undefined &&
            before.digest !== now.digest
          )
            changes.push({ path, kind: "changed" });
        }
        for (const path of known.keys())
          if (!current.has(path)) changes.push({ path, kind: "deleted" });
        known.clear();
        for (const [path, now] of current) known.set(path, now);
        reported = new Map();
        for (const change of changes) {
          if (change.kind === "deleted") continue;
          const at = current.get(change.path)?.version;
          if (at !== undefined) reported.set(change.path, at);
        }
        fire(changes);
      };
      const receivePayload = (tool: FilesTool, payload: EventPayload, announce = false) => {
        if (payload.type === "changes") run(() => batch(tool, payload.changes, announce));
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
        try {
          await seed(tool);
        } catch (error) {
          // A baseline that could not be read leaves nothing to reconcile against: stop watching
          // rather than report every later change as a create.
          await unsubscribe();
          throw error;
        }
        if (closed) return;
        const replay = buffered ?? [];
        buffered = undefined;
        hooks?.onReady?.();
        if (overflowed) run(() => rescan(tool));
        else for (const payload of replay) receivePayload(tool, payload, true);
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
