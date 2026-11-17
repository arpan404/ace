import { useClient } from "@ace/client-react";
import type {
  MarketEntryType,
  MarketMe,
  MarketPictureKind,
  MarketPublishAction,
  MarketPublishAnswer,
} from "@ace/protocol/marketplace";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { market, marketKey } from "./market-api.ts";
import { MarketFailure } from "./market-model.ts";

/*
 * ADR 0174 through the daemon: Discover's ranked sections, publisher pages, listing pictures and
 * the signed-in publisher's own page and actions (`publish`). Reads are queries under the
 * marketplace's key; every publish action is one mutation that reads the publisher's page again.
 */

const publishKey = [...marketKey, "publish"] as const;

/** Discover's hero, featured, trending, new, collections and top publishers. */
export function useMarketDiscover() {
  return useDaemonQuery({
    queryKey: [...marketKey, "discover"],
    read: async (client, signal) =>
      (await market(client, { op: "discover" }, "discover", signal)).discover,
  }).data;
}

/** A publisher's public page. */
export function useMarketPublisher(handle: string) {
  return useDaemonQuery({
    queryKey: [...marketKey, "publisher", handle],
    enabled: handle !== "",
    retry: false,
    read: async (client, signal) =>
      (await market(client, { op: "publisher", handle }, "publisher", signal)).page,
  });
}

/** A listing picture or avatar as a `data:` URL; undefined while it loads or when it can't. */
export function useMarketPicture(kind: MarketPictureKind, hash: string | undefined) {
  return useDaemonQuery({
    queryKey: [...marketKey, "picture", kind, hash ?? ""],
    enabled: hash !== undefined,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
    read: async (client, signal) => {
      const picture = await market(
        client,
        { op: "picture", kind, hash: hash ?? "" },
        "picture",
        signal,
      );
      return `data:${picture.type};base64,${picture.data}`;
    },
  }).data;
}

async function publishing<K extends MarketPublishAnswer["kind"]>(
  client: ReturnType<typeof useClient>,
  request: MarketPublishAction,
  kind: K,
  signal?: AbortSignal,
): Promise<Extract<MarketPublishAnswer, { kind: K }>> {
  const { answer } = await market(client, { op: "publish", request }, "publish", signal);
  if (answer.kind !== kind) throw new MarketFailure("failed");
  return answer as Extract<MarketPublishAnswer, { kind: K }>;
}

/**
 * The signed-in publisher's page. `signedOut` once the daemon says no ace account is signed in
 * on this machine, so the bar and the profile can offer "Sign in to publish".
 */
export function useMarketMe(): {
  me: MarketMe | undefined;
  signedOut: boolean;
  failed: boolean;
} {
  const query = useDaemonQuery({
    queryKey: [...publishKey, "me"],
    retry: false,
    read: async (client, signal) => (await publishing(client, { action: "me" }, "me", signal)).me,
  });
  const signedOut = query.error instanceof MarketFailure && query.error.code === "signed_out";
  return { me: query.data, signedOut, failed: query.isError && !signedOut };
}

/** One of the publisher's own entries, everything about it. */
export function useOwnEntry(type: MarketEntryType, name: string) {
  return useDaemonQuery({
    queryKey: [...publishKey, "entry", type, name],
    retry: false,
    read: async (client, signal) =>
      (await publishing(client, { action: "entry", type, name }, "entry", signal)).entry,
  });
}

/** An entry's downloads by day and version, adoption and reports: for its publisher only. */
export function useSignals(type: MarketEntryType, name: string, enabled: boolean) {
  return useDaemonQuery({
    queryKey: [...publishKey, "signals", type, name],
    enabled,
    retry: false,
    read: async (client, signal) =>
      (await publishing(client, { action: "signals", type, name }, "signals", signal)).signals,
  });
}

/** One publish action; afterwards the publisher's page and entries are read again. */
export function usePublishAction() {
  const client = useClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (request: MarketPublishAction) =>
      (await market(client, { op: "publish", request }, "publish")).answer,
    onSettled: () => void cache.invalidateQueries({ queryKey: publishKey }),
  });
}

/** Sends one publish action and answers it, for flows that step through several. */
export function usePublishRequest() {
  const client = useClient();
  return <K extends MarketPublishAnswer["kind"]>(request: MarketPublishAction, kind: K) =>
    publishing(client, request, kind);
}

/** Sends one publish action and answers whatever it answers. */
export function usePublishSend() {
  const client = useClient();
  return async (request: MarketPublishAction) =>
    (await market(client, { op: "publish", request }, "publish")).answer;
}
