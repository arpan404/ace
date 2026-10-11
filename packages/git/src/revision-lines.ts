import { ReviewRevision } from "@ace/protocol";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { readCheckpoint } from "./checkpoints.ts";
import { pathSchema } from "./decode.ts";
import { LineWindow } from "./line-window.ts";
import type { Repository } from "./repository.ts";
import { GitError, type DiffSide, type RevisionLines } from "./types.ts";

export interface RevisionLineOptions {
  worktree: string;
  revision: Exclude<DiffSide, { kind: "working-tree" }>;
  path: string;
  start: number;
  end: number;
}
const range = z
  .object({
    start: z.number().int().positive().max(10_000_003),
    end: z.number().int().positive().max(10_000_003),
  })
  .refine(({ start, end }) => end >= start && end - start < 106);

/** Read an immutable blob without buffering the file outside the requested review window. */
export async function readRevisionLines(
  repository: Repository,
  root: string,
  options: RevisionLineOptions,
): Promise<RevisionLines> {
  const { start, end } = range.parse(options);
  const path = pathSchema.parse(options.path);
  const revision = ReviewRevision.parse(options.revision);
  if (revision.kind === "working-tree")
    throw new GitError("invalid_argument", "Reading review lines requires an immutable revision");
  const sha =
    revision.kind === "checkpoint"
      ? (await readCheckpoint(repository, root, revision.id)).sha
      : await repository.commit(root, revision.ref);
  const window = new LineWindow(start, end, 8192);
  const decoder = new StringDecoder("utf8");
  await repository.cli.call(root, ["cat-file", "blob", `${sha}:${path}`], {
    captureBytes: 0,
    consume: (chunk) => window.append(decoder.write(chunk)),
  });
  window.append(decoder.end());
  const result = window.finish();
  if (!result) throw new GitError("output_too_large", "Review line window exceeds 8192 characters");
  return result;
}
