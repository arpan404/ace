import { basename } from "node:path";
import { lstat } from "node:fs/promises";
import {
  readHeadTail,
  readJsonLines,
  fingerprint,
  object,
  string,
  timestamp,
  RECORD_LIMIT,
} from "@ace/native-session";
import { HistorySession } from "@ace/protocol/history";
import { sourceRecords } from "./source-records.ts";
import { sessionTitle, userPrompt, hasUserInput } from "./user-text.ts";
import { storageFingerprint } from "./fingerprints.ts";
import { summary, sourceId } from "./metadata.ts";
import type { ByteBudget } from "./byte-budget.ts";
import type { ProviderHome } from "./contracts.ts";
import type { Catalog } from "./catalog.ts";

/** Head and tail windows sampled from each file. A file this small is decoded exactly. */
const SAMPLE_BYTES = 128 * 1024;
/** Largest record decoded while looking for a first prompt; larger ones are only counted. */
export const PREVIEW_RECORD_LIMIT = 128 * 1024;

export interface ScanTally {
  files: number;
  reads: number;
  bytes: number;
  skipped: number;
  unsupported: { instanceId: string; reason: string }[];
  retry: { instanceId: string; path: string }[];
}
export interface SampleContext {
  catalog: Catalog;
  instance: ProviderHome;
  epoch: number;
  signal: AbortSignal;
  result: ScanTally;
  /** Shared by every concurrent sample of this scan: bounds parsed records in flight. */
  budget: ByteBudget;
  /** Admits one decode above {@link PREVIEW_RECORD_LIMIT} at a time. */
  largeRecords: ByteBudget;
  report(): Promise<void>;
}
/** Applied to the catalog inside the scan's write transaction. */
export type CatalogWrite = () => void;

export function unsupported(result: ScanTally, instanceId: string, reason: string): void {
  if (result.unsupported.length < 256) result.unsupported.push({ instanceId, reason });
}

/** Sample one inventory file. Failures are recorded on the tally, never thrown, except abort. */
export async function sampleFile(
  context: SampleContext,
  path: string,
): Promise<CatalogWrite | undefined> {
  const { catalog, instance, epoch, signal, result } = context;
  try {
    return await processFile(context, path);
  } catch (error) {
    signal.throwIfAborted();
    const sourceChanged =
      error instanceof Error &&
      (error.message === "Session changed before sampling" ||
        error.message === "Session changed while sampling" ||
        error.message === "Session changed during import");
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (sourceChanged && result.retry.length < 4096)
      result.retry.push({ instanceId: instance.id, path });
    else if (!missing)
      unsupported(
        result,
        instance.id,
        error instanceof Error ? error.message : "Unreadable saved conversation",
      );
    result.skipped++;
    // A sampling race never changes or prunes the last successfully indexed row.
    return missing ? undefined : () => catalog.preservePath(instance.id, path, epoch);
  }
}

async function processFile(
  context: SampleContext,
  path: string,
): Promise<CatalogWrite | undefined> {
  const { catalog, instance, epoch, signal, result } = context;
  const isStorage = instance.provider === "opencode";
  if (!path.endsWith(isStorage ? ".json" : ".jsonl")) {
    if (path.endsWith(".zst") && !result.unsupported.some((r) => r.instanceId === instance.id))
      unsupported(
        result,
        instance.id,
        "Compressed Codex rollouts require provider-owned materialization",
      );
    return;
  }
  result.files++;
  if (result.files % 64 === 0) {
    await context.report();
    signal.throwIfAborted();
  }
  const info = await lstat(path);
  const fp = isStorage ? await storageFingerprint(instance, path, signal) : fingerprint(info);
  if (catalog.matches(instance.id, path, fp)) {
    result.skipped++;
    return () => {
      catalog.touch(instance.id, path, fp, epoch);
    };
  }
  const verdict = catalog.crashes.verdict(instance.id, path);
  if (verdict.kind === "blocked") {
    unsupported(result, instance.id, verdict.reason);
    result.skipped++;
    return () => catalog.preservePath(instance.id, path, epoch);
  }
  // Exact samples decode the whole small file. Larger ones decode two windows and may then
  // decode one bounded record at a time while looking for the first prompt.
  const reserve =
    !isStorage && info.size <= SAMPLE_BYTES ? info.size : SAMPLE_BYTES + PREVIEW_RECORD_LIMIT;
  return context.budget.use(reserve, async () => {
    signal.throwIfAborted();
    catalog.crashes.reading(instance.id, path);
    try {
      return await readContent(context, path, info, fp);
    } finally {
      catalog.crashes.finished(instance.id, path);
    }
  });
}

async function readContent(
  context: SampleContext,
  path: string,
  info: { size: number; mtimeMs: number },
  fp: string,
): Promise<CatalogWrite> {
  const { catalog, instance, epoch, signal, result } = context;
  const isStorage = instance.provider === "opencode";
  const sample = await readHeadTail(instance.homeDir, path, signal);
  result.reads++;
  result.bytes += sample.bytes;
  let s = summary(instance, path, sample.records, sample.exact, sample.mtime);
  if (isStorage) {
    const r = object(sample.records[0]);
    const time = object(r.time);
    const nativeId = string(r.id) ?? basename(path, ".json");
    s = HistorySession.parse({
      ...s,
      id: sourceId(instance.id, path, nativeId),
      nativeId,
      title: sessionTitle(string(r.title) ?? "", "", timestamp(time.updated) ?? sample.mtime),
      cwd: string(r.directory) ?? "",
      lastActivity: timestamp(time.updated) ?? sample.mtime,
      parentNativeId: string(r.parentID),
      countAccuracy: "sampled",
    });
  }
  if (!isStorage && fp !== sample.fingerprint) throw new Error("Session changed before sampling");
  let prompt = sample.records.map(userPrompt).find(Boolean) ?? "";
  let input = sample.records.some(hasUserInput);
  const headInput = sample.records.slice(0, sample.headCount).some(hasUserInput);
  if (isStorage || (!sample.exact && !headInput)) {
    const read = (limit: number) =>
      isStorage
        ? sourceRecords(
            instance,
            {
              summary: s,
              path,
              fingerprint: fp,
              kind: "storage",
              instanceId: instance.id,
              hidden: false,
            },
            signal,
            catalog.snapshots,
            limit,
          )
        : readJsonLines(instance.homeDir, path, signal, limit);
    const count = (bytes: number) => {
      if (!isStorage) result.bytes += bytes;
    };
    try {
      if (!isStorage) result.reads++;
      let found = await firstPrompt(read(PREVIEW_RECORD_LIMIT), PREVIEW_RECORD_LIMIT, count);
      if (!found.input && found.oversized) {
        // A first prompt above the preview window is still shown, but only one such record
        // is decoded at a time across the whole scan.
        if (!isStorage) result.reads++;
        found = await context.largeRecords.use(RECORD_LIMIT, () =>
          firstPrompt(read(RECORD_LIMIT), RECORD_LIMIT, count),
        );
      }
      prompt = found.prompt;
      input = found.input;
      if (!input && found.oversized) {
        const reason =
          "The first request in this saved conversation is too large to preview. Open it in its original app.";
        s = { ...s, support: { status: "unsupported", reason } };
        input = true;
        unsupported(result, instance.id, reason);
      }
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.message === "Session changed during import")
      )
        throw error;
      const reason =
        error instanceof Error
          ? error.message
          : "This saved conversation could not be read. Open it in its original app to recover its history.";
      s = { ...s, support: { status: "unsupported", reason } };
      // Keep the source visible to diagnostics, but never offer a partial import.
      input = true;
      unsupported(result, instance.id, reason);
    }
    if (!isStorage)
      s = {
        ...summary(instance, path, sample.records, sample.exact, sample.mtime, prompt),
        support: s.support,
      };
    s = {
      ...s,
      title: sessionTitle(
        isStorage
          ? (string(object(sample.records[0]).title) ?? "")
          : s.title.startsWith("Session from ")
            ? ""
            : s.title,
        prompt,
        s.lastActivity,
      ),
    };
  }
  const session = s;
  const hidden = !input;
  return () => {
    catalog.put(
      {
        summary: session,
        hidden,
        path,
        fingerprint: fp,
        kind: isStorage ? "storage" : "jsonl",
        instanceId: instance.id,
      },
      epoch,
    );
    catalog.remember(instance, path, info.size, info.mtimeMs, fp, epoch);
  };
}

type Decoded = { bytes: number } & (
  | { value: unknown }
  | { oversized: true }
  | { opaque: true }
  | { malformed: true }
);
async function firstPrompt(
  records: AsyncIterable<Decoded>,
  limit: number,
  count: (bytes: number) => void,
): Promise<{ prompt: string; input: boolean; oversized: boolean }> {
  let oversized = false;
  for await (const record of records) {
    count(record.bytes);
    if ("oversized" in record || ("opaque" in record && record.bytes > limit)) oversized = true;
    if ("value" in record && hasUserInput(record.value))
      return { prompt: userPrompt(record.value), input: true, oversized };
  }
  return { prompt: "", input: false, oversized };
}
