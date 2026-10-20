import { TurnStep } from "@ace/protocol";
import { z } from "zod";

/*
 * A finished turn's steps as kept between sessions: what one read of `turn.steps` returned, with
 * the turn's end it was read at. What a store hands back is untrusted (another build, a damaged
 * database): a record that doesn't parse, or names another turn, is no record.
 */

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const TurnStepsRecord = z.object({
  version: z.literal(1),
  threadId: z.string(),
  ordinal: count,
  endSeq: count,
  /** The turn has more steps than the record holds; `cursor` is where the next read goes on. */
  more: z.boolean(),
  cursor: count.nullable(),
  steps: z.array(TurnStep),
});
export type TurnStepsRecord = z.infer<typeof TurnStepsRecord>;

export function turnStepsRecord(
  threadId: string,
  ordinal: number,
  read: { endSeq: number; more: boolean; cursor: number | undefined; steps: readonly TurnStep[] },
): TurnStepsRecord {
  return {
    version: 1,
    threadId,
    ordinal,
    endSeq: read.endSeq,
    more: read.more,
    cursor: read.cursor ?? null,
    steps: [...read.steps],
  };
}

/** The stored record of this turn, or undefined when `value` is not one. */
export function parseTurnStepsRecord(
  value: unknown,
  threadId: string,
  ordinal: number,
): TurnStepsRecord | undefined {
  const parsed = TurnStepsRecord.safeParse(value);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  if (record.threadId !== threadId || record.ordinal !== ordinal) return undefined;
  if (record.more !== (record.cursor !== null)) return undefined;
  return record;
}
