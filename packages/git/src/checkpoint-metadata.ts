import { z } from "zod";
import { decode, hash, malformed, nul, Records } from "./decode.ts";
import { GitError, type Checkpoint } from "./types.ts";

const metadataSchema = z.object({
  format: z.literal("ace-checkpoint-v1"),
  threadId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  label: z.string(),
  createdAt: z.iso.datetime(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export function checkpointPrefix(threadId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId))
    throw new GitError(
      "invalid_argument",
      "threadId must contain only letters, digits, underscores or hyphens",
    );
  return `refs/ace/checkpoints/${threadId}/`;
}
export function checkpointIdentity(id: string): { threadId: string; sequence: number } {
  const match = /^refs\/ace\/checkpoints\/([A-Za-z0-9_-]+)\/([1-9]\d*)$/.exec(id);
  if (!match) throw new GitError("checkpoint_not_found", `Invalid checkpoint id: ${id}`);
  const [threadId, sequenceText] = decode(
    z.tuple([z.string(), z.string()]),
    match.slice(1),
    "checkpoint id",
  );
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence))
    throw new GitError("checkpoint_not_found", `Invalid checkpoint id: ${id}`);
  return { threadId, sequence };
}
export function metadata(message: string) {
  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    throw malformed("checkpoint JSON");
  }
  return decode(metadataSchema, data, "checkpoint metadata");
}
export interface ParsedCommit {
  sha: string;
  tree: string;
  data: ReturnType<typeof metadata>;
}
export function parseCommits(buffer: Buffer): Map<string, ParsedCommit> {
  const commits = new Map<string, ParsedCommit>();
  const records = new Records(nul(buffer));
  while (!records.done()) {
    const sha = hash(records.next());
    const tree = hash(records.next());
    const data = metadata(records.next());
    if (commits.has(sha)) throw malformed("duplicate commit record");
    commits.set(sha, { sha, tree, data });
  }
  return commits;
}
export function checkpoint(
  id: string,
  commit: { sha: string; tree: string; data: ReturnType<typeof metadata> },
): Checkpoint {
  const { threadId, sequence } = checkpointIdentity(id);
  if (
    threadId !== commit.data.threadId ||
    (commit.data.sequence !== undefined && sequence !== commit.data.sequence)
  )
    throw malformed("checkpoint identity");
  return {
    id,
    sha: commit.sha,
    tree: commit.tree,
    threadId,
    sequence,
    label: commit.data.label,
    createdAt: commit.data.createdAt,
  };
}
