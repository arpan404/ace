import { z } from "zod";

/*
 * Where Spade, the main bot, lives (ADR 0187): a record the person's machines share,
 * `{host, version, at, by}`. Each machine keeps the newest it has heard of and shows its main bot
 * only while the record names it. Nothing elects a host: a window only copies the newest record to
 * machines holding an older one, and writes the first record once, naming the Spade it finds.
 */

export interface SpadeHostRecord {
  /** The machine's ace host id. */
  host: string;
  version: number;
  at: number;
  /** `person`, `seed` (a window's first record) or `move`. */
  by: string;
}

const recordShape = z.object({
  host: z.string().min(1).max(128),
  version: z.number().int().positive(),
  at: z.number(),
  by: z.enum(["person", "seed", "move"]),
});

/** A record as Spade sent it; undefined for none or one that doesn't read. */
export function parseSpadeHostRecord(raw: unknown): SpadeHostRecord | undefined {
  const parsed = recordShape.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `GET /v1/main`: the record this machine holds, and whether its main bot shows. */
export interface SpadeMainState {
  here: string | undefined;
  host: SpadeHostRecord | undefined;
  shown: boolean;
  /** The person switched Spade off on this machine. */
  off: boolean;
}

const mainShape = z.object({
  here: z.string().nullish().catch(undefined),
  host: z.unknown().optional(),
  shown: z.boolean().catch(true).default(true),
  off: z.boolean().catch(false).default(false),
});

export function parseSpadeMain(body: string): SpadeMainState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = mainShape.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    here: parsed.data.here ?? undefined,
    host: parseSpadeHostRecord(parsed.data.host),
    shown: parsed.data.shown,
    off: parsed.data.off,
  };
}

const byHost = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `a` replaces `b`: a higher version, then a later time, then the higher host id. */
export function newerSpadeHost(a: SpadeHostRecord, b: SpadeHostRecord): boolean {
  if (a.version !== b.version) return a.version > b.version;
  if (a.at !== b.at) return a.at > b.at;
  return byHost(a.host, b.host) > 0;
}

/** The newest of the records machines hold. */
export function newestSpadeHost(
  records: readonly (SpadeHostRecord | undefined)[],
): SpadeHostRecord | undefined {
  let newest: SpadeHostRecord | undefined;
  for (const record of records)
    if (record && (!newest || newerSpadeHost(record, newest))) newest = record;
  return newest;
}

/** One machine as a window reads it: its host id, the record it holds, and its main bot. */
export interface SpadeHostSeen {
  host: string;
  record: SpadeHostRecord | undefined;
  /** Its main bot while it lists one. */
  main: { createdAt: number } | undefined;
}

export interface SpadeHostSync {
  /** The fleet's choice: the newest record, or the first one this window writes. */
  choice: SpadeHostRecord | undefined;
  /** Machines to send the choice to (`PUT /v1/main/host`): theirs is older, or missing. */
  tell: string[];
}

/**
 * What a window does about the host choice, from every machine whose Spade answers. With a
 * record anywhere, it copies the newest to the rest. With none anywhere, and only once every
 * machine has answered (`settled`), it writes the first: the machine that shows Spade now (the
 * oldest main if several do), else `own`, the window's machine.
 */
export function spadeHostSync(
  seen: readonly SpadeHostSeen[],
  settled: boolean,
  own: string,
  now: number,
): SpadeHostSync {
  const stale = (choice: SpadeHostRecord) =>
    seen
      .filter((machine) => !machine.record || newerSpadeHost(choice, machine.record))
      .map((machine) => machine.host);
  const newest = newestSpadeHost(seen.map((machine) => machine.record));
  if (newest) return { choice: newest, tell: stale(newest) };
  if (!settled || seen.length === 0) return { choice: undefined, tell: [] };
  const showing = seen
    .flatMap((machine) =>
      machine.main ? [{ host: machine.host, at: machine.main.createdAt }] : [],
    )
    .toSorted((a, b) => a.at - b.at || byHost(a.host, b.host));
  const host = showing[0]?.host ?? (seen.some((m) => m.host === own) ? own : seen[0]?.host);
  if (host === undefined) return { choice: undefined, tell: [] };
  const choice = { host, version: 1, at: now, by: "seed" };
  return { choice, tell: stale(choice) };
}
