import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MachineUpdateAsk, MachineUpdateOutcome } from "@ace/protocol";
import { durableJson, UpdateOutcome, updateOutcomeFile } from "@ace/service";
import type { Installing } from "./rules.ts";

/** What survives a restart: the request being carried out, the install under way, the last end. */
export interface UpdateRecord {
  ask: MachineUpdateAsk | null;
  installing: Installing | null;
  last: MachineUpdateOutcome | null;
}

const Stored = z.object({
  ask: MachineUpdateAsk.nullable().catch(null),
  installing: z
    .object({
      from: z.string().min(1).max(80),
      to: z.string().min(1).max(80),
      mode: z.enum(["idle", "now"]),
      at: z.number().int().nonnegative(),
    })
    .nullable()
    .catch(null),
  last: MachineUpdateOutcome.nullable().catch(null),
});

/** How the standalone updater ended (`ace update apply --outcome`). */
export const UpdaterOutcome = UpdateOutcome;
export type UpdaterOutcome = UpdateOutcome;

export const recordFile = "machine-update.json";

export interface RecordStore {
  load(): Promise<UpdateRecord>;
  save(record: UpdateRecord): Promise<void>;
  /** Reads and removes the standalone updater's outcome, if it left one. */
  takeOutcome(): Promise<UpdaterOutcome | undefined>;
}

const empty: UpdateRecord = { ask: null, installing: null, last: null };

/** The record in `directory` (the daemon's data directory). A damaged file reads as empty. */
export function fileRecord(directory: string): RecordStore {
  const path = join(directory, recordFile);
  const outcome = join(directory, updateOutcomeFile);
  return {
    async load() {
      try {
        return Stored.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        return empty;
      }
    },
    save: (record) => durableJson(path, record),
    async takeOutcome() {
      let text: string;
      try {
        text = await readFile(outcome, "utf8");
      } catch {
        return undefined;
      }
      await rm(outcome, { force: true });
      try {
        return UpdaterOutcome.parse(JSON.parse(text));
      } catch {
        return undefined;
      }
    },
  };
}

/** A record held in memory, for daemons without a data directory and for tests. */
export function memoryRecord(initial: UpdateRecord = empty): RecordStore & {
  outcome?: UpdaterOutcome;
} {
  let record = initial;
  const store: RecordStore & { outcome?: UpdaterOutcome } = {
    load: async () => record,
    save: async (next) => {
      record = next;
    },
    takeOutcome: async () => {
      const taken = store.outcome;
      delete store.outcome;
      return taken;
    },
  };
  return store;
}
