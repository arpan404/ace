import { z } from "zod";
import { basename, join, relative } from "node:path";
import {
  MigrationFailure,
  firstLine,
  walkFiles,
  exists,
  type CopyFile,
} from "./migration-files.ts";
export const NativeSessionId = z
  .string()
  .regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
const sessionMeta = z
  .object({
    type: z.literal("session_meta"),
    payload: z
      .object({
        id: NativeSessionId,
        session_id: NativeSessionId.optional(),
        forked_from_id: NativeSessionId.nullish(),
        parent_thread_id: NativeSessionId.nullish(),
        history_mode: z.string().optional(),
        history_base: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type MigrationPlan = { files: CopyFile[]; ids: string[]; action: "fork" | "resume" };
export async function codexPlan(home: string, id: string): Promise<MigrationPlan> {
  const sessions = new Map<string, { path: string; parents: string[]; unsupported: boolean }>();
  const failures = new Map<string, string>();
  const fail = (path: string, reason: string) => {
    const candidate = basename(path).match(
      /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i,
    )?.[0];
    if (candidate) failures.set(candidate, reason);
  };
  const budget = { entries: 0 };
  for (const root of ["sessions", "archived_sessions"]) {
    for await (const path of walkFiles(join(home, root), budget)) {
      if (path.endsWith(".zst")) {
        fail(path, "Compressed Codex rollouts need provider-owned materialization");
        continue;
      }
      if (!path.endsWith(".jsonl")) continue;
      let value: unknown;
      try {
        value = JSON.parse(await firstLine(path));
      } catch {
        fail(path, "Unrecognized Codex rollout metadata");
        continue;
      }
      const parsed = sessionMeta.safeParse(value).data;
      if (!parsed) {
        fail(path, "Unrecognized Codex rollout metadata");
        continue;
      }
      const meta = parsed.payload;
      if (sessions.has(meta.id)) {
        failures.set(meta.id, "Multiple physical rollouts need provider-owned materialization");
        continue;
      }
      sessions.set(meta.id, {
        path,
        parents: [
          ...new Set(
            [
              meta.forked_from_id,
              meta.parent_thread_id,
              meta.session_id === meta.id ? undefined : meta.session_id,
            ].filter((p): p is string => typeof p === "string"),
          ),
        ],
        unsupported:
          (meta.history_mode !== undefined && meta.history_mode !== "legacy") ||
          meta.history_base != null,
      });
    }
  }
  const files: CopyFile[] = [];
  const ids: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (current: string, depth: number) => {
    if (depth > 128) throw new MigrationFailure("refused", "Lineage depth limit exceeded");
    if (visiting.has(current)) throw new MigrationFailure("refused", "Cyclic session lineage");
    if (visited.has(current)) return;
    const failure = failures.get(current);
    if (failure) throw new MigrationFailure("unsupported", failure);
    const session = sessions.get(current);
    if (!session) throw new MigrationFailure("refused", "Missing session or ancestor rollout");
    if (session.unsupported)
      throw new MigrationFailure(
        "unsupported",
        "Paginated Codex history needs provider-owned materialization",
      );
    visiting.add(current);
    for (const parent of session.parents) visit(parent, depth + 1);
    visiting.delete(current);
    visited.add(current);
    if (files.length >= 512) throw new MigrationFailure("refused", "Lineage size limit exceeded");
    ids.push(current);
    files.push({ source: session.path, relative: relative(home, session.path) });
  };
  visit(id, 0);
  return { files, ids, action: "fork" };
}
export async function claudePlan(home: string, id: string): Promise<MigrationPlan> {
  let root: string | undefined;
  for await (const path of walkFiles(join(home, "projects"))) {
    if (basename(path) !== `${id}.jsonl`) continue;
    if (root) throw new MigrationFailure("refused", "Ambiguous Claude session ID");
    root = path;
  }
  if (!root) throw new MigrationFailure("refused", "Missing Claude session transcript");
  const files: CopyFile[] = [];
  const subagents = join(root.slice(0, -6), "subagents");
  for await (const source of walkFiles(subagents)) {
    if (files.length >= 512) throw new MigrationFailure("refused", "Sidechain file limit exceeded");
    files.push({ source, relative: relative(home, source) });
  }
  files.push({ source: root, relative: relative(home, root) });
  return { files, ids: [id], action: "resume" };
}
export async function checkWriterLocks(
  home: string,
  provider: "codex" | "claude",
  ids: readonly string[],
) {
  for (const id of ids) {
    const paths =
      provider === "codex"
        ? [join(home, "thread-writer-locks", `${id}.lock`)]
        : [join(home, "session-locks", `${id}.lock`)];
    for (const path of paths)
      if (await exists(path))
        throw new MigrationFailure(
          "refused",
          "Session writer lock exists; stop the CLI before migrating",
        );
  }
}
