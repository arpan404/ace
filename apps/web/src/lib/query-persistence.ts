import type { ReadSnapshotStorage } from "@ace/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import * as z from "zod/mini";

/*
 * The daemon lookups behind the screens people open most (the project list, the model catalog,
 * provider and account state, host identity, skills, automations), kept between sessions beside
 * the connection's read snapshots (ADR 0030), so a reload or a slow remote link paints them at
 * once instead of a skeleton. What is kept is shown as it was and asked for again as soon as a
 * view reads it: every restored entry starts out invalidated, whatever its view's staleTime.
 * File contents, diffs, search results, logs and anything holding a client object are never
 * kept.
 */

/** Which queries are kept: a key that starts with one of these (or is exactly it). */
const keptKeys: readonly { prefix: readonly string[]; exact?: true }[] = [
  { prefix: ["projects"], exact: true },
  { prefix: ["host", "identity"], exact: true },
  { prefix: ["models", "list"], exact: true },
  { prefix: ["accounts", "list"], exact: true },
  { prefix: ["providers", "statuses"], exact: true },
  { prefix: ["providers", "readiness"], exact: true },
  { prefix: ["onboarding"], exact: true },
  { prefix: ["settings", "providers"], exact: true },
  { prefix: ["project", "base-refs"] },
  { prefix: ["permissions", "capabilities"] },
  { prefix: ["skills"], exact: true },
  { prefix: ["automations", "list"], exact: true },
];

const KeyPart = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PlainKey = z.array(KeyPart);

/** Whether a query with `key` is kept between sessions. */
export function keptQuery(key: QueryKey): boolean {
  if (!PlainKey.safeParse(key).success) return false;
  return keptKeys.some(
    ({ prefix, exact }) =>
      (exact ? key.length === prefix.length : key.length >= prefix.length) &&
      prefix.every((part, index) => key[index] === part),
  );
}

/** The record's key in the connection's read snapshot storage. */
export const queryRecordKey = "queries";
/** At most this many queries are kept; the newest win. */
export const keptQueryLimit = 200;
/** Changes are written at most once per this many milliseconds. */
export const queryWriteMs = 1_000;

const QueryRecord = z.object({
  version: z.literal(1),
  /** The build that wrote it: another build's data may have another shape. */
  build: z.string(),
  /** The daemon that answered: a daemon started afresh at the same address is another one. */
  hostId: z.string(),
  queries: z.array(z.object({ key: PlainKey, data: z.unknown(), at: z.number() })),
});
type QueryRecord = z.infer<typeof QueryRecord>;

/** The queries `value` holds for this build and daemon, or none. */
export function parseQueryRecord(
  value: unknown,
  expected: { build: string; hostId: string },
): QueryRecord["queries"] {
  const parsed = QueryRecord.safeParse(value);
  if (!parsed.success) return [];
  const record = parsed.data;
  if (record.build !== expected.build || record.hostId !== expected.hostId) return [];
  return record.queries.filter((entry) => entry.data !== undefined && keptQuery(entry.key));
}

/** What `queries` keeps of its cache now: successful kept queries, newest first. */
export function queryRecord(
  queries: QueryClient,
  stamp: { build: string; hostId: string },
): QueryRecord {
  const kept = queries
    .getQueryCache()
    .findAll({
      predicate: (query) =>
        query.state.status === "success" &&
        query.state.data !== undefined &&
        keptQuery(query.queryKey),
    })
    .toSorted((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, keptQueryLimit);
  return {
    version: 1,
    ...stamp,
    queries: kept.flatMap((query) => {
      const key = PlainKey.safeParse(query.queryKey);
      return key.success
        ? [{ key: key.data, data: query.state.data, at: query.state.dataUpdatedAt }]
        : [];
    }),
  };
}

/**
 * Put what was kept into `queries`, never over newer data, and mark it for asking again: each
 * view that reads one refetches it on mount, while showing what was kept.
 */
export function restoreQueries(queries: QueryClient, kept: QueryRecord["queries"]): void {
  const restored = new Set<string>();
  for (const entry of kept) {
    const state = queries.getQueryState(entry.key);
    if (state && state.data !== undefined && state.dataUpdatedAt >= entry.at) continue;
    queries.setQueryData(entry.key, entry.data, { updatedAt: entry.at });
    const hash = queries.getQueryCache().find({ queryKey: entry.key, exact: true })?.queryHash;
    if (hash) restored.add(hash);
  }
  if (restored.size)
    void queries.invalidateQueries({
      predicate: (query) => restored.has(query.queryHash),
      refetchType: "none",
    });
}

/**
 * Keep `queries`' kept lookups in `storage` for the daemon `hostId`: restore what an earlier
 * session kept, then write changes at most once a second while `writable()` (the connection is
 * up; once the daemon refuses this credential its records are dropped and none are written).
 * Returns the stop, which drops any write not yet made.
 */
export function persistQueries(options: {
  queries: QueryClient;
  storage: ReadSnapshotStorage;
  build: string;
  hostId: string;
  writable(): boolean;
  schedule(delayMs: number, run: () => void): () => void;
}): () => void {
  const { queries, storage } = options;
  const stamp = { build: options.build, hostId: options.hostId };
  let stopped = false;
  let pending: (() => void) | undefined;
  void storage.get(queryRecordKey).then(
    (value) => {
      if (!stopped) restoreQueries(queries, parseQueryRecord(value, stamp));
    },
    () => {},
  );
  const write = () => {
    pending = undefined;
    if (stopped || !options.writable()) return;
    // `set` copies the record before it yields.
    void storage.set(queryRecordKey, queryRecord(queries, stamp)).catch(() => {});
  };
  const unsubscribe = queries.getQueryCache().subscribe((event) => {
    if (stopped || pending || event.type !== "updated" || event.action.type !== "success") return;
    if (!keptQuery(event.query.queryKey)) return;
    pending = options.schedule(queryWriteMs, write);
  });
  return () => {
    stopped = true;
    pending?.();
    pending = undefined;
    unsubscribe();
  };
}
