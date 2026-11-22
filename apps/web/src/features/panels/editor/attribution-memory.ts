import { ProviderKind } from "@ace/protocol";
import { z } from "zod";
import type { AttributionMemory, SavedAttribution } from "./live-gutter.ts";

/*
 * Agents' lines kept on this device (localStorage), per file of a checkout on a machine, for the
 * lines they were measured on, so a reload shows them again while those lines are unchanged. The
 * whole store is bounded by its serialized size (the files written longest ago go first), a file
 * with too many blocks is not kept, and a full device lets older files go rather than fail.
 */

const storageKey = "ace.editor.agent-lines";

/** What the device keeps: one serialized store, at most `bytes` long; files of at most `blocks`. */
export interface AttributionLimits {
  bytes: number;
  blocks: number;
}

export const defaultLimits: AttributionLimits = { bytes: 200_000, blocks: 2_000 };

/** The part of `Storage` this needs. */
export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const Entry = z.object({
  written: z.number(),
  lines: z.number(),
  blocks: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      at: z.number(),
      hash: z.string(),
      who: z.object({
        name: z.string(),
        provider: z.string().optional(),
        turn: z.number().optional(),
      }),
    }),
  ),
});
const Store = z.record(z.string(), Entry);
type Store = z.infer<typeof Store>;

/** The store as kept, read leniently: anything unreadable is nothing kept. */
function load(storage: KeyValue): Store {
  try {
    const parsed = Store.safeParse(JSON.parse(storage.getItem(storageKey) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Newest written first, cut to the size bound. */
function bounded(store: Store, bytes: number): [string, z.infer<typeof Entry>][] {
  const entries = Object.entries(store).toSorted(([, a], [, b]) => b.written - a.written);
  const kept: [string, z.infer<typeof Entry>][] = [];
  let size = 2;
  for (const entry of entries) {
    const more = JSON.stringify(entry[0]).length + JSON.stringify(entry[1]).length + 2;
    if (size + more > bytes) break;
    size += more;
    kept.push(entry);
  }
  return kept;
}

export function deviceAttribution(
  storage: KeyValue,
  limits: AttributionLimits = defaultLimits,
  now: () => number = () => Date.now(),
): AttributionMemory {
  /** Writes the newest `count` files; on a full device, half as many, then none. */
  const save = (entries: [string, z.infer<typeof Entry>][]) => {
    for (let count = entries.length; ; count = Math.floor(count / 2)) {
      try {
        if (count === 0) storage.removeItem(storageKey);
        else
          storage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries.slice(0, count))));
        return;
      } catch {
        if (count === 0) return;
      }
    }
  };
  return {
    read: (key) => {
      const entry = load(storage)[key];
      if (!entry) return undefined;
      const blocks = entry.blocks.map((block) => ({
        ...block,
        who: {
          name: block.who.name,
          provider: ProviderKind.safeParse(block.who.provider).data,
          ...(block.who.turn === undefined ? {} : { turn: block.who.turn }),
        },
      }));
      return { lines: entry.lines, blocks } satisfies SavedAttribution;
    },
    write: (key, saved) => {
      const store = load(storage);
      if (saved && saved.blocks.length <= limits.blocks)
        store[key] = {
          written: now(),
          lines: saved.lines,
          blocks: saved.blocks.map((block) => ({
            start: block.start,
            end: block.end,
            at: block.at,
            hash: block.hash,
            who: {
              name: block.who.name,
              ...(block.who.provider ? { provider: block.who.provider } : {}),
              ...(block.who.turn === undefined ? {} : { turn: block.who.turn }),
            },
          })),
        };
      else delete store[key];
      save(bounded(store, limits.bytes));
    },
  };
}
