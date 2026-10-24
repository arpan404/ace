import type { MachineThread } from "@ace/client/machines";
import { arrayEqual, useSelection } from "@ace/client-react";
import { ThreadId, type ThreadListEntry } from "@ace/protocol";
import { useMemo } from "react";
import { useMachinePool } from "./machine-pool.ts";

/*
 * Other machines' threads in this window's list (ADR 0100). Each is listed under a row id that
 * names its machine, so a thread id two daemons share stays two rows, and nothing that acts on
 * this daemon's ids can mistake one for its own.
 */

const prefix = "machine:";

/** The list's id for a pool row: its pool key (`machineThreadKey`, `[hostId, threadId]`). */
export function machineRowId(row: MachineThread): ThreadId {
  return ThreadId.parse(`${prefix}${row.key}`);
}

/** The machine, thread and pool key a list id names, when it is another machine's. */
export function machineRow(
  id: string,
): { hostId: string; threadId: string; key: string } | undefined {
  if (!id.startsWith(prefix)) return undefined;
  const key = id.slice(prefix.length);
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return { hostId: parsed[0], threadId: parsed[1], key };
  } catch {
    // Not one of ours.
  }
  return undefined;
}

const none: readonly MachineThread[] = [];
const noEntries: readonly ThreadListEntry[] = [];

/**
 * Every other machine's threads as list entries under their machine row ids, from the pool's
 * merged store: live while a machine is online, its last facts while it isn't. `own` (this
 * window's host id) is left out, should the directory list it too.
 */
export function useMachineEntries(own: string | undefined): readonly ThreadListEntry[] {
  const pool = useMachinePool();
  const selection = useMemo(
    () =>
      pool?.threads.select(
        ["ids", "threads"],
        (store) =>
          store.ids.flatMap((key) => {
            const row = store.thread(key);
            return row ? [row] : [];
          }),
        arrayEqual,
      ),
    [pool],
  );
  const rows = useSelection(selection) ?? none;
  return useMemo(() => {
    const entries = rows.flatMap((row) =>
      row.hostId === own ? [] : [{ ...row.thread, id: machineRowId(row) }],
    );
    return entries.length ? entries : noEntries;
  }, [rows, own]);
}

/** One other machine's thread as the pool last heard it, for a row while it is offline. */
export function useMachineThread(key: string): ThreadListEntry | undefined {
  const pool = useMachinePool();
  const selection = useMemo(
    () => pool?.threads.select([`thread:${key}`], (store) => store.thread(key)?.thread),
    [pool, key],
  );
  return useSelection(selection);
}
