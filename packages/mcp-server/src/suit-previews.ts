import type { McpAttribution } from "@ace/protocol";
import type { SuitId, SuitProblem } from "@ace/protocol/suits";
import type { SuitPort } from "./suit-port.ts";

export type SuitApplyStatus =
  | "previewing"
  | "kept"
  | "reverted"
  | "refused"
  | "not-found"
  | "nothing-to-do";

export interface SuitApplyOutcome {
  status: SuitApplyStatus;
  suit: SuitId | null;
  problems: SuitProblem[];
  next: string;
}

/** What one thread changed: the Suit it is previewing, or the keep it can undo. */
interface ThreadLook {
  undo?: { suit: SuitId; restore(): Promise<void> };
}

/**
 * The preview, keep and revert rules behind `suit_apply`. The person has one preview at a time:
 * the latest one wins, and only the thread that started it ends it (its revert or its turn's
 * end). A keep can be undone once, by the thread that made it. Nothing applies unless the
 * Suit's checks pass right then.
 */
export class SuitPreviews {
  private readonly threads = new Map<string, ThreadLook>();
  /** The thread whose preview is showing, and which Suit it shows. */
  private showing: { caller: McpAttribution; suit: SuitId } | undefined;

  private readonly port: SuitPort;
  constructor(port: SuitPort) {
    this.port = port;
  }

  async preview(caller: McpAttribution, id: SuitId | undefined, signal: AbortSignal) {
    if (!id)
      return outcome("nothing-to-do", null, "Pass id: the Suit's folder name in ~/.ace/suits.");
    const refused = await this.check(id, signal);
    if (refused) return refused;
    await this.port.preview(caller, id);
    this.showing = { caller, suit: id };
    return outcome(
      "previewing",
      id,
      "Look at ace in the browser, then keep or revert before your turn ends.",
    );
  }

  async keep(caller: McpAttribution, id: SuitId | undefined, signal: AbortSignal) {
    const suit = id ?? this.ownPreview(caller);
    if (!suit)
      return outcome(
        "nothing-to-do",
        null,
        "No preview of yours is showing; pass id to keep a Suit.",
      );
    const refused = await this.check(suit, signal);
    if (refused) return refused;
    const { restore } = await this.port.keep(caller, suit);
    if (this.showing?.caller.threadId === caller.threadId) this.showing = undefined;
    this.threads.set(caller.threadId, { undo: { suit, restore } });
    return outcome("kept", suit, "Kept on the person's devices. revert once undoes it.");
  }

  async revert(caller: McpAttribution) {
    const previewing = this.ownPreview(caller);
    if (previewing) {
      await this.end(caller);
      return outcome("reverted", previewing, "The preview ended; the kept look is back.");
    }
    const undo = this.threads.get(caller.threadId)?.undo;
    if (!undo)
      return outcome("nothing-to-do", null, "Nothing of yours to revert: no preview and no keep.");
    await undo.restore();
    this.threads.delete(caller.threadId);
    return outcome("reverted", undo.suit, "The look from before the keep is back.");
  }

  /** A turn ended (`run.ended`): its thread's preview, if still showing, ends with it. */
  async turnEnded(threadId: string): Promise<void> {
    const showing = this.showing;
    if (showing?.caller.threadId === threadId) await this.end(showing.caller);
  }

  private ownPreview(caller: McpAttribution): SuitId | undefined {
    return this.showing?.caller.threadId === caller.threadId ? this.showing.suit : undefined;
  }

  private async end(caller: McpAttribution): Promise<void> {
    this.showing = undefined;
    await this.port.preview(caller, null);
  }

  /** A refusal when the Suit is missing or fails a check; undefined when it can apply. */
  private async check(id: SuitId, signal: AbortSignal): Promise<SuitApplyOutcome | undefined> {
    const summary = await this.port.validate(id, signal);
    if (!summary)
      return outcome("not-found", id, `No Suit at ~/.ace/suits/${id}/; write suit.json there.`);
    if (summary.problems.length === 0) return undefined;
    return {
      status: "refused",
      suit: id,
      problems: summary.problems,
      next: "Nothing was applied. Fix each problem's field in its scheme, then preview again.",
    };
  }
}

function outcome(status: SuitApplyStatus, suit: SuitId | null, next: string): SuitApplyOutcome {
  return { status, suit, problems: [], next };
}
