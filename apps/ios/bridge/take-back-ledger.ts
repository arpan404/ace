import { readServerQueue, type ClientCore } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { DismissedSends } from "./dismissed-sends.ts";

/*
 * Words on their way back to the composer, kept in the machine's own store until the phone has
 * them in that thread's saved draft. Edit removes a queued message (or dismisses a failed send)
 * only after its record is saved, and the phone acknowledges once the words are in the draft. A
 * runtime that stops in between leaves the record: the next launch looks at how the removal
 * ended and either gives the words back (the original is gone) or drops the record (the original
 * is still there, so giving them back would send them twice).
 */

const Record = z.object({
  id: z.string().min(1).max(128),
  threadId: z.string().min(1).max(256),
  text: z.string().max(200_000),
  /** `queue`: a held message removed by command `removal`; `send`: a failed send dismissed. */
  kind: z.enum(["queue", "send"]),
  /** The queued message or failed send the words came from. */
  source: z.string().min(1).max(256),
  removal: z.string().min(1).max(256).optional(),
});
export type TakeBackRecord = z.infer<typeof Record>;
const Kept = z.array(Record).max(32);

export interface TakeBackLedger {
  /** Resolves true once the record is saved; nothing is removed before that. */
  record(entry: TakeBackRecord): Promise<boolean>;
  /** The words are in the draft, or were never taken: forget the record. */
  settle(id: string): Promise<void>;
  /** The records kept, once loaded. */
  kept(): Promise<readonly TakeBackRecord[]>;
}

export function followTakeBacks(native: {
  load(): Promise<string>;
  save(value: string): Promise<void>;
}): TakeBackLedger {
  let records: readonly TakeBackRecord[] = [];
  let turn: Promise<unknown> = native
    .load()
    .then((text) => {
      let raw: unknown = [];
      try {
        raw = text ? JSON.parse(text) : [];
      } catch {
        raw = [];
      }
      records = Kept.safeParse(raw).data ?? [];
    })
    .catch(() => {});
  const change = (next: (current: readonly TakeBackRecord[]) => readonly TakeBackRecord[]) => {
    const run = turn.then(async () => {
      const updated = next(records);
      if (updated === records) return true;
      try {
        await native.save(JSON.stringify(updated));
      } catch {
        return false;
      }
      records = updated;
      return true;
    });
    turn = run;
    return run;
  };
  return {
    record: (entry) =>
      change((current) => [...current.filter((each) => each.id !== entry.id), entry].slice(-32)),
    settle: async (id) => {
      await change((current) =>
        current.some((each) => each.id === id) ? current.filter((each) => each.id !== id) : current,
      );
    },
    kept: async () => {
      await turn;
      return records;
    },
  };
}

/** Nothing kept: a runtime without the store (older hosts, tests that don't need it). */
export const keepNoTakeBacks: TakeBackLedger = {
  record: async () => true,
  settle: async () => {},
  kept: async () => [],
};

/** How a removal command ended: true removed, false refused, undefined unknown to this outbox. */
function removalOutcome(
  owner: Pick<ClientCore, "intent">,
  id: string,
): Promise<boolean> | undefined {
  const intent = owner.intent(id);
  if (!intent.getSnapshot()) return undefined;
  return new Promise((resolve) => {
    const settle = () => {
      const result = intent.getSnapshot()?.result;
      if (!result) return;
      stop();
      resolve(result.ok);
    };
    const stop = intent.subscribe(settle);
    settle();
  });
}

/**
 * At launch: each record left by a runtime that stopped. Words whose original is gone go back
 * (`give`); a record whose original is still there is dropped. A record that can't be decided yet
 * (offline) stays for the next launch.
 */
export async function recoverTakeBacks(
  ledger: TakeBackLedger,
  owner: Pick<ClientCore, "intent" | "request">,
  dismissed: Pick<DismissedSends, "has" | "loaded">,
  give: (entry: TakeBackRecord) => void,
): Promise<void> {
  for (const entry of await ledger.kept()) {
    let gone: boolean;
    if (entry.kind === "send") {
      await dismissed.loaded();
      gone = dismissed.has(entry.source);
    } else {
      const outcome = entry.removal ? removalOutcome(owner, entry.removal) : undefined;
      if (outcome) gone = await outcome;
      else {
        // The outbox no longer knows the removal: the daemon's queue says whether it is gone.
        try {
          const page = await readServerQueue(
            ThreadId.parse(entry.threadId),
            async (request) => (await owner.request({ type: "queue.get", ...request })).queue,
          );
          gone = !page.messages.some((message) => message.id === entry.source);
        } catch {
          continue;
        }
      }
    }
    if (gone) give(entry);
    else await ledger.settle(entry.id);
  }
}
