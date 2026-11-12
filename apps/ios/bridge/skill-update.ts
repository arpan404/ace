import { SkillHash, SkillId, SkillUpdateReview, WorkspaceId } from "@ace/protocol";
import {
  changedFilesText,
  countChanges,
  diffTexts,
  extensionDisplayName,
  fold,
  runnableFileText,
  updateChangeWords,
  updateStatusText,
  type DiffRow,
} from "@ace/ui-core";
import { z } from "zod";
import { expect, Refused, skills, type SkillOwner } from "./skill-requests.ts";

/*
 * Updating a skill installed from a repository, for the phone: check its source for a newer
 * version, fetch that version for review (each file it changes, and SKILL.md line by line),
 * then apply exactly what was reviewed or let the review go. The words are `@ace/ui-core`'s,
 * the web's update dialog's too.
 *
 * An Update whose answer is lost is sent again with `retry`. The daemon has used the review up
 * by then, so it refuses; the skill's recorded folder hash tells whether it now holds the
 * reviewed version (the first send applied) or not (a real refusal).
 */

const scope = { workspaceId: WorkspaceId.optional() };
export const NativeSkillUpdateRequest = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("checkUpdate"),
    id: SkillId,
    ...scope,
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("prepareUpdate"),
    id: SkillId,
    ...scope,
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("applyUpdate"),
    id: SkillId,
    ...scope,
    reviewId: SkillUpdateReview.shape.id,
    expectedHash: SkillHash,
    folderHash: SkillUpdateReview.shape.folderHash,
    retry: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("cancelUpdate"),
    reviewId: SkillUpdateReview.shape.id,
  }),
]);
export type NativeSkillUpdateRequest = z.infer<typeof NativeSkillUpdateRequest>;

const updateOps: ReadonlySet<string> = new Set(
  NativeSkillUpdateRequest.options.map((option) => option.shape.op.value),
);
export const isSkillUpdate = (request: { op: string }): request is NativeSkillUpdateRequest =>
  updateOps.has(request.op);

/** Said when the machine didn't answer. An Update may have applied: the next send says retry. */
const unreachable = "Couldn't reach the machine. Try again; nothing applies twice.";

export async function answerSkillUpdate(
  owner: SkillOwner,
  request: NativeSkillUpdateRequest,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return { ok: true, ...(await answer(owner, request, signal)) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "unreachable", message: unreachable };
  }
}

async function answer(
  owner: SkillOwner,
  request: NativeSkillUpdateRequest,
  signal: AbortSignal,
): Promise<object> {
  if (request.op === "cancelUpdate") {
    expect(
      await skills(owner, { op: "cancelUpdate", reviewId: request.reviewId }, signal),
      "cancelled",
    );
    return {};
  }
  const at = request.workspaceId ? { workspaceId: request.workspaceId } : {};
  switch (request.op) {
    case "checkUpdate": {
      const status = expect(
        await skills(owner, { op: "checkUpdate", id: request.id, ...at }, signal),
        "updateStatus",
      ).status;
      return { available: status === "available", status: updateStatusText[status] };
    }
    case "prepareUpdate": {
      // Read first: once a review is staged, nothing after it may fail and leave it behind.
      const { entry } = expect(
        await skills(owner, { op: "read", id: request.id, ...at }, signal),
        "skill",
      );
      const review = expect(
        await prepareOwned(owner, request.id, at, signal),
        "updateReview",
      ).review;
      const files = changedFilesText(review.files.length);
      return {
        review: {
          id: review.id,
          title: `Update ${extensionDisplayName(entry.name, entry.title)}`,
          summary: entry.source ? `${entry.source.source} · ${files}` : files,
          baseHash: review.baseHash,
          folderHash: review.folderHash,
          files: review.files.map((file) => ({
            path: file.path,
            change: updateChangeWords[file.change],
            runnable: file.flagged ? runnableFileText : null,
          })),
          diff: diffView(fold(diffTexts(review.before, review.after))),
        },
      };
    }
    case "applyUpdate": {
      const result = await skills(
        owner,
        {
          op: "applyUpdate",
          id: request.id,
          reviewId: request.reviewId,
          // The folder the review compared against: an edit since makes the daemon refuse.
          expectedHash: request.expectedHash,
          ...at,
        },
        signal,
      );
      if (request.retry && result.kind === "error" && retried.has(result.code)) {
        const now = expect(
          await skills(owner, { op: "read", id: request.id, ...at }, signal),
          "skill",
        );
        if (now.entry.source?.folderHash === request.folderHash) return applied(now.entry);
      }
      return applied(expect(result, "skill").entry);
    }
  }
}

/** As long as a fetch for review may take; the daemon lets an abandoned review go after 30 min. */
const preparing = { timeoutMs: 300_000 };
/** For a request nobody can call off: it must be answered so its effect can be undone. */
const unowned = new AbortController().signal;

/**
 * Prepare an update the bridge owns until the phone has its review. The daemon keeps a staged
 * review, one of a few, until it is applied or cancelled, so the request isn't tied to the
 * asker's signal: a review that arrives after the asker gave up (its sheet closed while the
 * repository was fetched) is cancelled at once rather than dropped unseen.
 */
async function prepareOwned(
  owner: SkillOwner,
  id: string,
  at: { workspaceId?: string },
  signal: AbortSignal,
) {
  const reply = await owner.request(
    { type: "skills.request", operation: { op: "prepareUpdate", id, ...at } },
    preparing,
  );
  const result = reply.result;
  if (!signal.aborted || result.kind !== "updateReview") return result;
  await skills(owner, { op: "cancelUpdate", reviewId: result.review.id }, unowned).catch(
    () => undefined,
  );
  throw new Refused("cancelled", "The update review was closed.");
}

/** The refusals a second send of an applied update gets: its review is gone, its hash moved. */
const retried = new Set(["not_found", "conflict"]);

function applied(entry: { name: string; title?: string | undefined; hash: string }) {
  return { hash: entry.hash, notice: `Updated ${extensionDisplayName(entry.name, entry.title)}` };
}

/** SKILL.md's diff as the phone draws it: numbered lines, unchanged runs folded to a count. */
function diffView(rows: readonly DiffRow[]) {
  const { additions, deletions } = countChanges(rows);
  return {
    additions,
    deletions,
    rows: rows.map((row) =>
      row.kind === "fold"
        ? {
            kind: "fold",
            number: null,
            text: row.count === 1 ? "1 unchanged line" : `${row.count ?? "Some"} unchanged lines`,
          }
        : {
            kind: row.kind,
            number: (row.kind === "del" ? row.old : (row.new ?? row.old)) ?? null,
            text: row.text,
          },
    ),
  };
}
