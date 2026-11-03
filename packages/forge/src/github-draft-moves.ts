import { z } from "zod";
import type { ForgeReviewDraft } from "@ace/protocol/forge-review";
import { ForgeError } from "./errors.ts";
import { decode, type ReviewIo } from "./review-io.ts";
import {
  draftsToMove,
  moveDraft,
  movedDraft,
  type Comparison,
  type DraftMove,
} from "./review-draft-move.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const patch = z.string().max(4_194_304).optional();
const Compare = z.looseObject({
  status: text,
  files: z
    .array(
      z.looseObject({
        filename: text,
        previous_filename: text.optional(),
        status: text,
        patch,
      }),
    )
    .max(300)
    .optional(),
  commits: z
    .array(z.looseObject({ parents: z.array(z.looseObject({ sha })).max(64).optional() }))
    .max(10_000)
    .optional(),
});
const Content = z.looseObject({ encoding: z.string().max(32), content: z.string() });
/** GitHub lists at most this many files in one comparison. */
const compareFileCap = 300;
/** Old files read for an outdated draft's code, at most, in one move. */
const maxFileReads = 10;

/**
 * The reads behind moving drafts to a new head: GitHub's comparison of each draft's commit with
 * the head, the PR's patch at the head, and, for code no patch shows, the old file.
 */
export async function moveDrafts(
  io: ReviewIo,
  number: number,
  headSha: string,
  drafts: readonly ForgeReviewDraft[],
  signal: AbortSignal,
): Promise<ForgeReviewDraft[]> {
  const targets = draftsToMove(drafts, headSha);
  if (!targets.length) return [];
  const hosted = (
    await io.records(
      `${io.root}/pulls/${number}/files?per_page=100`,
      z.looseObject({ filename: text, patch }),
      signal,
    )
  ).map((f) => ({ path: f.filename, patch: f.patch }));
  const comparisons = new Map<string, Comparison>();
  for (const commit of new Set(targets.map((d) => d.anchor.commit))) {
    if (comparisons.size >= 20) throw new ForgeError("limit");
    comparisons.set(commit, await compare(io, commit, headSha, signal));
  }
  let reads = 0;
  const moved: ForgeReviewDraft[] = [];
  for (const draft of targets) {
    const comparison = comparisons.get(draft.anchor.commit);
    if (!comparison) throw new ForgeError("invalid_data");
    let move: DraftMove = moveDraft(draft, headSha, comparison, hosted);
    // No patch showed its lines: the old file says what they were.
    if (move.kind === "outdated" && !move.code.length && draft.anchor.side === "RIGHT")
      if (reads++ < maxFileReads) {
        const file = await oldFile(io, draft.anchor.path, draft.anchor.commit, signal);
        if (file) move = moveDraft(draft, headSha, comparison, hosted, file);
      }
    moved.push(movedDraft(draft, move, headSha));
  }
  return moved;
}

async function compare(io: ReviewIo, from: string, to: string, signal: AbortSignal) {
  const body = decode(
    Compare,
    (await io.request(`${io.root}/compare/${from}...${to}`, signal)).body,
  );
  const files = body.files ?? [];
  return {
    // Ahead: every commit since descends from the draft's. Anything else rewrote history.
    descends: body.status === "ahead" || body.status === "identical",
    merges: (body.commits ?? []).some((c) => (c.parents?.length ?? 0) > 1),
    complete: body.files !== undefined && files.length < compareFileCap,
    files: files.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename,
      status: f.status,
      patch: f.patch,
    })),
  } satisfies Comparison;
}

/** The file's lines at `commit`, or undefined when it can't be read as text. */
async function oldFile(io: ReviewIo, path: string, commit: string, signal: AbortSignal) {
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  try {
    const response = await io.request(
      `${io.root}/contents/${segments.map(encodeURIComponent).join("/")}?ref=${commit}`,
      signal,
    );
    const content = Content.safeParse(response.body);
    if (!content.success || content.data.encoding !== "base64") return undefined;
    return Buffer.from(content.data.content, "base64").toString("utf8").split("\n");
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}
