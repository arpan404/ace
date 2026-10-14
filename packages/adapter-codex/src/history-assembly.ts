import { list, obj, str, type Obj } from "./native.ts";

/**
 * Rebuilds a thread snapshot from a history read's bounded notes (`history.ts`). Notes arrive in
 * order; the parts of a split turn share its id and are joined. The `thread-discovered` note
 * that ends the read carries the same `history` number; notes from any other read are dropped.
 */
export function historyAssembly() {
  const reads = new Map<string, { read: number; turns: Obj[] }>();
  return {
    add(note: Obj): void {
      const thread = str(note["threadId"]);
      const read = note["read"];
      if (!thread || typeof read !== "number") return;
      let entry = reads.get(thread);
      if (entry?.read !== read) {
        entry = { read, turns: [] };
        reads.set(thread, entry);
      }
      for (const value of list(note["turns"])) {
        const turn = obj(value);
        const last = entry.turns.at(-1);
        if (last && str(turn["id"]) && last["id"] === turn["id"])
          last["items"] = [...list(last["items"]), ...list(turn["items"])];
        else entry.turns.push(turn);
      }
    },
    /** The discovered thread with its history in place of the note's empty turn list. */
    complete(note: Obj): Obj {
      const thread = obj(note["thread"]);
      const id = str(thread["id"]);
      const entry = reads.get(id);
      reads.delete(id);
      if (typeof note["history"] !== "number") return thread;
      const history = entry?.read === note["history"] ? entry.turns : [];
      return { ...thread, turns: [...history, ...list(thread["turns"])] };
    },
  };
}

/** An opening reply that excluded turns: metadata, with neither turns nor a status to act on. */
export function metadataOnly(thread: Obj): Obj {
  return Object.fromEntries(
    Object.entries(thread).filter(([key]) => key !== "turns" && key !== "status"),
  );
}
