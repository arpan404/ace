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
import { MarketFailure, searchType, shownBy, type MarketFilter } from "./market-model.ts";

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
  if (result.op === "error") throw new MarketFailure(result.code);
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

/** Search the device's copy of the listings; `spade` narrows to Spade's types after. */
export function useMarketSearch(input: { query: string; filter: MarketFilter; category?: string }) {
  const type = searchType(input.filter);
  return useDaemonQuery({
    queryKey: [...marketKey, "search", input.query, input.filter, input.category ?? ""],
    read: async (client, signal) => {
      const found = await market(
        client,
        {
          op: "search",
          query: input.query,
          limit: 100,
          ...(type ? { type } : {}),
          ...(input.category ? { category: input.category } : {}),
        },
        "search",
        signal,
      );
      return {
        ...found,
        entries: found.entries.filter((entry) => shownBy(input.filter, entry.type)),
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

export interface EntryKey {
  source: string;
  type: string;
  name: string;
}

export function useMarketEntry(key: EntryKey) {
  return useDaemonQuery({
    queryKey: [...marketKey, "entry", key.source, key.type, key.name],
    read: (client, signal) => market(client, { op: "read", ...key }, "read", signal),
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

const reviewKey = (key: EntryKey, update: boolean) =>
  [...marketKey, "review", key.source, key.type, key.name, update ? "update" : "install"] as const;

/**
 * The entry's review, prepared once and held while its page and review are open (the daemon
 * keeps it 30 minutes). `update` reviews the newer version of an installed entry.
 */
export function useMarketReview(key: EntryKey, options: { update: boolean; enabled: boolean }) {
  return useDaemonQuery<PreparedReview>({
    queryKey: reviewKey(key, options.update),
    enabled: options.enabled,
    staleTime: 25 * 60_000,
    retry: false,
    read: async (client, signal) => {
      const prepared = await market(
        client,
        options.update
          ? { op: "prepareUpdate", type: typeOf(key.type), name: key.name }
          : { op: "prepare", ...key },
        "review",
        signal,
      );
      return readAll(client, prepared.review, signal);
    },
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
    onSettled: (_answer, _error, input) => {
      cache.removeQueries({ queryKey: [...marketKey, "review"] });
      void cache.invalidateQueries({ queryKey: marketKey });
      return input;
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
