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
        history_base: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const historyBase = z.object({ thread_id: NativeSessionId }).passthrough();
export type MigrationPlan = { files: CopyFile[]; ids: string[]; action: "fork" | "resume" };
const lowerIds = (candidates: unknown[]) =>
  candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
/** A Codex rollout's name ends in its thread ID: `rollout-<time>-<id>.jsonl[.zst]`. */
const rolloutName = /([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl(\.zst)?$/i;
/**
 * The session and every rollout it builds on: fork parents, the spawning thread and the base a
 * paginated fork reads through. Rollouts are found by name and only the lineage's own files are
 * opened, so a large normal CLI home costs a directory walk, not a read of every session.
 */
export async function codexPlan(home: string, id: string): Promise<MigrationPlan> {
  const found = new Map<string, string[]>();
  const budget = { entries: 0, limit: 200_000 };
  for (const root of ["sessions", "archived_sessions"])
    for await (const path of walkFiles(join(home, root), budget)) {
      const match = basename(path).match(rolloutName)?.[1]?.toLowerCase();
      if (match) found.set(match, [...(found.get(match) ?? []), path]);
    }
  const files: CopyFile[] = [];
  const lineage: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = async (current: string, depth: number, required: boolean): Promise<void> => {
    if (depth > 128) throw new MigrationFailure("refused", "Lineage depth limit exceeded");
    if (visiting.has(current)) throw new MigrationFailure("refused", "Cyclic session lineage");
    if (visited.has(current)) return;
    const paths = found.get(current) ?? [];
    const path = paths[0];
    if (!path && !required) return;
    if (!path) throw new MigrationFailure("unsupported", "Missing session or ancestor rollout");
    if (paths.length > 1)
      throw new MigrationFailure(
        "unsupported",
        "Multiple physical rollouts need provider-owned materialization",
      );
    if (path.endsWith(".zst"))
      throw new MigrationFailure(
        "unsupported",
        "Compressed Codex rollouts need provider-owned materialization",
      );
    let value: unknown;
    try {
      value = JSON.parse(await firstLine(path));
    } catch {
      throw new MigrationFailure("unsupported", "Unrecognized Codex rollout metadata");
    }
    const meta = sessionMeta.safeParse(value).data?.payload;
    if (meta?.id.toLowerCase() !== current)
      throw new MigrationFailure("unsupported", "Unrecognized Codex rollout metadata");
    // A fork reads its parent's history; the spawning thread and tree root are only references.
    const history = lowerIds([
      meta.forked_from_id,
      historyBase.safeParse(meta.history_base).data?.thread_id,
    ]);
    const references = lowerIds([
      meta.parent_thread_id,
      meta.session_id === meta.id ? undefined : meta.session_id,
    ]).filter((parent) => !history.includes(parent));
    visiting.add(current);
    for (const parent of new Set(history)) await visit(parent, depth + 1, true);
    for (const parent of new Set(references)) await visit(parent, depth + 1, false);
    visiting.delete(current);
    visited.add(current);
    if (files.length >= 512) throw new MigrationFailure("refused", "Lineage size limit exceeded");
    lineage.push(current);
    files.push({ source: path, relative: relative(home, path) });
  };
  await visit(id.toLowerCase(), 0, true);
  return { files, ids: lineage, action: "fork" };
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
/**
 * Claude marks a live session with a lock file. Codex's lock files outlive their writers, so a
 * Codex copy relies on the lease, which holds the real lock, instead of reading the directory.
 */
export async function checkWriterLocks(
  home: string,
  provider: "codex" | "claude",
  ids: readonly string[],
) {
  if (provider === "codex") return;
  for (const id of ids)
    if (await exists(join(home, "session-locks", `${id}.lock`)))
      throw new MigrationFailure(
        "refused",
        "Session writer lock exists; stop the CLI before migrating",
      );
}
