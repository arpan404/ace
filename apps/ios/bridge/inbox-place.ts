import { ThreadId } from "@ace/protocol";
import { placePinned } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { InboxOrganizer } from "./inbox-organize.ts";

/*
 * Pinning and placing inbox threads, with the payloads the web's Home list sends: `thread.pin`
 * (with an `order` when moving among pinned threads) and `thread.place` for the hand-sorted list.
 *
 * The phone shows one inbox across machines, so a move is worked out over the group as the
 * phone shows it, every machine's rows together, by the shared `placePinned`. Swift sends the
 * same move to each machine in the group; each works out the same places and records only its
 * own threads', so the merged order is the one the person made, even when a whole group needs
 * fresh places. Places are plain numbers compared across machines, as the merged ranks are.
 */

const Shown = z.object({
  machineId: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
  /** The row's `pinOrder` or `listOrder`; null for a pin from before places existed. */
  order: z.number().finite().nullable(),
});

export const PlaceAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pin"), threadId: ThreadId, pinned: z.boolean() }),
  z.object({
    kind: z.literal("move"),
    /** Among pinned threads, or in the list sorted by hand. */
    group: z.enum(["pinned", "listed"]),
    /** The moving thread, on the machine named. */
    machineId: z.string().min(1).max(256),
    threadId: ThreadId,
    /** The group as the phone shows it, top first, every machine's rows. */
    shown: z.array(Shown).max(5_000),
    /** Its new place among the others, 0 at the top. */
    to: z.number().int().nonnegative(),
  }),
]);
export type PlaceAction = z.infer<typeof PlaceAction>;

const keyOf = (machineId: string, id: string) => `${machineId}\u0000${id}`;

/**
 * Run a pin or a move on this machine's threads. The admission under `requestId` says whether
 * every command it took was saved here; a move that changes none of this machine's threads
 * is admitted at once.
 */
export async function runPlace(
  organizer: InboxOrganizer,
  action: PlaceAction,
  requestId: string,
  pump: PatchSink,
): Promise<void> {
  if (action.kind === "pin") {
    const { threadId, pinned } = action;
    await organizer.run(
      threadId,
      { pinned },
      { type: "thread.pin", threadId, pinned },
      requestId,
      pump,
    );
    return;
  }
  const own = new Map(
    action.shown
      .filter((row) => row.machineId === organizer.machineId)
      .map((row) => [keyOf(row.machineId, row.id), row.id]),
  );
  const moves = placePinned(
    action.shown.map((row) => ({
      id: keyOf(row.machineId, row.id),
      order: row.order ?? undefined,
    })),
    [keyOf(action.machineId, action.threadId)],
    action.to,
  ).flatMap((move) => {
    const id = own.get(move.id);
    const threadId = id === undefined ? undefined : ThreadId.safeParse(id);
    return threadId?.success ? [{ threadId: threadId.data, order: move.order }] : [];
  });
  const saved = await Promise.all(
    moves.map(({ threadId, order }, index) =>
      action.group === "pinned"
        ? organizer.run(
            threadId,
            { pinned: true, pinOrder: order },
            { type: "thread.pin", threadId, pinned: true, order },
            `${requestId}.${index}`,
            pump,
          )
        : organizer.run(
            threadId,
            { listOrder: order },
            { type: "thread.place", threadId, order },
            `${requestId}.${index}`,
            pump,
          ),
    ),
  );
  const ok = saved.every(Boolean);
  pump.put(`admission:${requestId}`, () => ({
    type: "admission",
    id: requestId,
    ok,
    message: ok ? "" : "Could not save the move on this device.",
  }));
}
