import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type {
  MarketInstallChoices,
  MarketOperation,
  MarketResult,
  MarketReview,
  MarketReviewItem,
} from "@ace/protocol/marketplace";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { z } from "zod";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { MarketEntryKey } from "./market-address.ts";
import { MarketFailure } from "./market-model.ts";

/*
 * The daemon's marketplace (ADR 0168 §13) as the app reads it: `marketplace.request` per
 * operation, each answer checked for the kind asked, the lists as queries that `marketplace.changed`
 * refreshes, and a review held per entry from `prepare` to Install or Cancel.
 */

type Operation = z.input<typeof MarketOperation>;
type Answer<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

function answers<T extends MarketResult["op"]>(result: MarketResult, op: T): result is Answer<T> {
  return result.op === op;
}

export async function market<T extends MarketResult["op"]>(
  client: ClientApi,
  operation: Operation,
  expected: T,
  signal?: AbortSignal,
): Promise<Answer<T>> {
  const reply = await client.request(
    { type: "marketplace.request", operation },
    signal ? { signal } : {},
  );
  const result = reply.result;
  if (result.op === "error") throw new MarketFailure(result.code, result.scan, result.message);
  if (!answers(result, expected)) throw new MarketFailure("failed");
  return result;
}

export const marketKey = ["marketplace"] as const;

export function useMarketHome() {
  return useDaemonQuery({
    queryKey: [...marketKey, "home"],
    read: (client, signal) => market(client, { op: "home" }, "home", signal),
  });
}

export function useMarketSources() {
  return useDaemonQuery({
    queryKey: [...marketKey, "sources"],
    read: (client, signal) => market(client, { op: "sources" }, "sources", signal),
  });
}

/**
 * Search the device's copy of the listings. `types` narrows to those types (one is sent to the
 * daemon; several are narrowed after); an empty query lists everything of them.
 */
export function useMarketSearch(input: { query: string; types?: readonly string[] | undefined }) {
  const types = input.types;
  const one = types?.length === 1 ? types[0] : undefined;
  return useDaemonQuery({
    queryKey: [...marketKey, "search", input.query, ...(types ?? [])],
    read: async (client, signal) => {
      const found = await market(
        client,
        { op: "search", query: input.query, limit: 100, ...(one ? { type: one } : {}) },
        "search",
        signal,
      );
      return {
        ...found,
        entries: types
          ? found.entries.filter((entry) => types.includes(entry.type))
          : found.entries,
      };
    },
    placeholderData: (previous) => previous,
  });
}

export function useMarketInstalled() {
  return useDaemonQuery({
    queryKey: [...marketKey, "installed"],
    read: (client, signal) => market(client, { op: "installed" }, "installed", signal),
  });
}

export type EntryKey = MarketEntryKey;

/** Only an entry's key: a summary passed as one carries fields the daemon's ops refuse. */
const keyOnly = (key: EntryKey): EntryKey => ({
  source: key.source,
  type: key.type,
  name: key.name,
});

export function useMarketEntry(key: EntryKey) {
  return useDaemonQuery({
    queryKey: [...marketKey, "entry", key.source, key.type, key.name],
    read: (client, signal) => market(client, { op: "read", ...keyOnly(key) }, "read", signal),
  });
}

/** A review and every row of its pages, read through `readReview` until it has them all. */
export interface PreparedReview {
  review: MarketReview;
  items: MarketReviewItem[];
}

async function readAll(client: ClientApi, review: MarketReview, signal: AbortSignal) {
  const items: MarketReviewItem[] = [];
  let offset: number | undefined = review.items ? 0 : undefined;
  for (let page = 0; offset !== undefined && page < 20; page++) {
    const next: Answer<"reviewPage"> = await market(
      client,
      { op: "readReview", id: review.id, offset },
      "reviewPage",
      signal,
    );
    items.push(...next.items);
    offset = next.nextOffset;
  }
  return { review, items };
}

export const reviewKey = (key: EntryKey, update: boolean) =>
  [...marketKey, "review", key.source, key.type, key.name, update ? "update" : "install"] as const;

/**
 * The entry's review, prepared once and held while its page and review are open (the daemon
 * keeps it 30 minutes). `update` reviews the newer version of an installed entry.
 */
export function useMarketReview(key: EntryKey, options: { update: boolean; enabled: boolean }) {
  return useDaemonQuery<PreparedReview>({
    queryKey: reviewKey(key, options.update),
    enabled: options.enabled,
    staleTime: reviewStale,
    retry: false,
    read: (client, signal) => prepareReview(client, key, options.update, signal),
  });
}

const reviewStale = 25 * 60_000;

async function prepareReview(
  client: ClientApi,
  key: EntryKey,
  update: boolean,
  signal: AbortSignal,
) {
  const prepared = await market(
    client,
    update
      ? { op: "prepareUpdate", type: typeOf(key.type), name: key.name }
      : { op: "prepare", ...keyOnly(key) },
    "review",
    signal,
  );
  return readAll(client, prepared.review, signal);
}

/**
 * The entry's install review, from the cache when its page already prepared it, else prepared
 * now: what Try it reads a Suit's look from before it is installed.
 */
export function usePrepareReview() {
  const client = useClient();
  const cache = useQueryClient();
  return (key: EntryKey) =>
    cache.fetchQuery({
      queryKey: reviewKey(key, false),
      staleTime: reviewStale,
      retry: false,
      queryFn: ({ signal }) => prepareReview(client, key, false, signal),
    });
}

/** Drops every held review and list, so the pages read the marketplace again. */
function useForget() {
  const cache = useQueryClient();
  return () => void cache.invalidateQueries({ queryKey: marketKey });
}

export function useInstall() {
  const client = useClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: { review: MarketReview; choices: MarketInstallChoices }) =>
      market(
        client,
        { op: "install", id: input.review.id, hash: input.review.hash, choices: input.choices },
        "done",
      ),
    // The review is spent once installed, or once the daemon says it is stale. Any other
    // refusal (a sign-in, a busy daemon) leaves it in place, so the page keeps saying why and
    // Install can run again on the same review.
    onSettled: (_answer, error) => {
      const stale =
        !error ||
        (error instanceof MarketFailure && (error.code === "expired" || error.code === "conflict"));
      if (stale) cache.removeQueries({ queryKey: [...marketKey, "review"] });
      void cache.invalidateQueries({ queryKey: [...marketKey, "installed"] });
      if (!error) void cache.invalidateQueries({ queryKey: marketKey });
    },
  });
}

export function useCancelReview() {
  const client = useClient();
  const cache = useQueryClient();
  return (review: MarketReview | undefined) => {
    cache.removeQueries({ queryKey: [...marketKey, "review"] });
    if (review) void market(client, { op: "cancel", id: review.id }, "done").catch(() => {});
  };
}

/** Turns a withdrawn or turned-off entry back on, from its pinned bytes. */
export function useTurnOn() {
  const client = useClient();
  const forget = useForget();
  return useMutation({
    mutationFn: (input: { type: string; name: string }) =>
      market(client, { op: "turnOn", type: typeOf(input.type), name: input.name }, "done"),
    onSettled: forget,
  });
}

export function useRemove() {
  const client = useClient();
  const forget = useForget();
  return useMutation({
    mutationFn: (input: { type: string; name: string }) =>
      market(client, { op: "remove", type: typeOf(input.type), name: input.name }, "done"),
    onSettled: forget,
  });
}

export function useAddSource() {
  const client = useClient();
  const forget = useForget();
  return useMutation({
    mutationFn: (address: string) => market(client, { op: "addSource", address }, "sources"),
    onSuccess: forget,
  });
}

export function useRemoveSource() {
  const client = useClient();
  const forget = useForget();
  return useMutation({
    mutationFn: (id: string) => market(client, { op: "removeSource", id }, "sources"),
    onSuccess: forget,
  });
}

const installableTypes = [
  "suit",
  "spade-skill",
  "spade-plugin",
  "spade-bot",
  "ace-plugin",
] as const;
type InstalledType = (typeof installableTypes)[number];
function typeOf(type: string): InstalledType {
  const found = installableTypes.find((known) => known === type);
  if (!found) throw new MarketFailure("not_found");
  return found;
}

/** Reads the lists again whenever the daemon says installs or update counts changed. */
export function useMarketChanges() {
  const client = useClient();
  const cache = useQueryClient();
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type !== "marketplace.changed") return;
        void cache.invalidateQueries({ queryKey: [...marketKey, "home"] });
        void cache.invalidateQueries({ queryKey: [...marketKey, "installed"] });
        void cache.invalidateQueries({ queryKey: [...marketKey, "entry"] });
      }),
    [client, cache],
  );
}
