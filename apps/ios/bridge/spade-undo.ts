import {
  parseSpadeUndoPreview,
  SpadeRequestError,
  spadePastTime,
  spadeUndoSummary,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { NativeSpade } from "./spade.ts";
import { segment } from "./spade-text.ts";
import type { SpadeAsk, SpadeRefusal } from "./spade-requests-area.ts";

/*
 * Undo in a bot's conversation (ADR 0167, spade/docs/security.md "Undo in the conversation"), as
 * web's `spade-undo.tsx`: first what putting the checkpoint from before a step back would do,
 * then putting it back. Nothing changes until the person confirms; the bot is told afterwards.
 */

const agentId = z.string().min(1).max(256);

export const spadeUndoRequests = [
  /** What undoing from the step at `seq` (and everything after it) would put back. */
  z.object({
    type: z.literal("spade.undo.preview"),
    agentId,
    seq: z.number().int().nonnegative(),
    /** The person's time zone, for when the checkpoint was taken. */
    timeZone: z.string().min(1).max(64).optional(),
  }),
  /** Puts the checkpoint the preview named back. */
  z.object({ type: z.literal("spade.undo"), agentId, checkpoint: z.string().min(1).max(256) }),
] as const;

type Preview = z.infer<(typeof spadeUndoRequests)[0]>;
type Undo = z.infer<(typeof spadeUndoRequests)[1]>;

const checkpoints = (agent: string) => `/v1/agents/${segment(agent)}/checkpoints`;

const said = (message: string): SpadeRefusal => ({ ok: false, title: "Couldn't undo", message });

/** Why Spade refused an undo, in the person's words. */
function refused(name: string, error: unknown): SpadeRefusal {
  if (error instanceof SpadeRequestError && error.status === 409) {
    if (error.message.includes("services"))
      return said(`${name}'s services are running. Stop them first.`);
    if (error.message.includes("being restored")) return said("An undo is already running.");
    return said(`${name} is working. Stop it first, then undo.`);
  }
  if (error instanceof SpadeRequestError && error.status === 404)
    return said("There's no checkpoint from before this anymore, so it can't be undone.");
  return said((error instanceof Error && error.message) || "Try again.");
}

/** The confirm's words and lists: the files that go back, go and come back. */
export async function previewUndo(
  spade: NativeSpade,
  request: Preview,
  ask: SpadeAsk,
  now: number,
) {
  const name = spade.bot(request.agentId)?.name || "The bot";
  try {
    const body = await ask("GET", `${checkpoints(request.agentId)}/undo?seq=${request.seq}`);
    const preview = parseSpadeUndoPreview(JSON.parse(body) as unknown);
    if (!preview) throw new Error("Spade's undo didn't make sense.");
    const when = spadePastTime(preview.checkpoint.at, {
      now,
      ...(request.timeZone ? { timeZone: request.timeZone } : {}),
    });
    const summary = spadeUndoSummary(preview);
    const empty = !preview.changed.length && !preview.added.length && !preview.deleted.length;
    return {
      ok: true as const,
      undo: {
        checkpoint: preview.checkpoint.id,
        sentence: `${name}'s files go back to how they were at ${when}: ${summary.toLowerCase()}. Anything changed after that goes back too.`,
        changed: [...preview.changed],
        added: [...preview.added],
        deleted: [...preview.deleted],
        more: preview.more,
        empty,
      },
    };
  } catch (error) {
    return refused(name, error);
  }
}

/** Puts the checkpoint back; the conversation then shows what the bot was told. */
export async function undo(spade: NativeSpade, request: Undo, ask: SpadeAsk) {
  const name = spade.bot(request.agentId)?.name || "The bot";
  try {
    await ask("POST", `${checkpoints(request.agentId)}/${segment(request.checkpoint)}/restore`);
    spade.refresh();
    return { ok: true as const, message: `Undone. ${name} knows its files went back.` };
  } catch (error) {
    return refused(name, error);
  }
}
