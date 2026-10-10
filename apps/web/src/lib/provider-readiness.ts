import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { accountView, type AccountView } from "@ace/ui-core";
import type { OnboardingResult, ProviderStatus } from "@ace/protocol";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/*
 * Whether each provider can run a thread (`providers.request { operation: "readiness" }`) and
 * this device's first-run checklist (`onboarding.query`), kept live by the daemon's
 * `providers.changed` pushes: a sign-in finished anywhere updates every open surface.
 */

/** One effective row per provider: installed, signed in as whom, or what it needs. */
export type ProviderReadiness = ProviderStatus;
export type Onboarding = Extract<OnboardingResult["result"], { ok: true }>;

export const readinessKey = ["providers", "readiness"] as const;
export const onboardingKey = ["onboarding"] as const;
/**
 * Other reads that describe providers and go stale with a sign-in: the pickers' statuses
 * (`provider-statuses.ts`) and Settings' list. Matched as prefixes.
 */
const dependentKeys: readonly QueryKey[] = [
  ["providers", "statuses"],
  ["settings", "providers"],
  ["accounts"],
  onboardingKey,
];

async function readReadiness(client: ClientApi, signal?: AbortSignal): Promise<ProviderStatus[]> {
  const reply = await client.request(
    { type: "providers.request", operation: "readiness" },
    signal ? { signal } : {},
  );
  if (!reply.result.ok) throw new Error("Provider readiness is unavailable");
  return reply.result.providers;
}

async function readOnboarding(client: ClientApi, signal?: AbortSignal): Promise<Onboarding> {
  const reply = await client.request({ type: "onboarding.query" }, signal ? { signal } : {});
  if (!reply.result.ok) throw new Error("Setup is unavailable on ace on this machine");
  return reply.result;
}

/** After a sign-in, a sign-out or new discovery: read every provider description again. */
export function refreshProviders(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: readinessKey });
  for (const queryKey of dependentKeys) void queryClient.invalidateQueries({ queryKey });
}

const watchers = new WeakMap<ClientApi, { users: number; stop(): void }>();

/**
 * One listener per client while anything shows providers: a `providers.changed` push replaces
 * readiness in place and has the other descriptions read again; a reconnect reads all of them,
 * since pushes may have been missed meanwhile.
 */
function watchProviders(client: ClientApi, queryClient: QueryClient): () => void {
  let watcher = watchers.get(client);
  if (!watcher) {
    const connection = client.connectionState();
    let ready = connection.getSnapshot() === "ready";
    const stops = [
      client.onMessage((message) => {
        if (message.type === "usage.limits_changed") {
          const account = accountView(message.account);
          // Stop an older in-flight read from overwriting the committed limit push.
          if (queryClient.getQueryData(["accounts", "list"]))
            void queryClient.cancelQueries({ queryKey: ["accounts", "list"] });
          else void queryClient.invalidateQueries({ queryKey: ["accounts", "list"] });
          queryClient.setQueryData<AccountView[]>(["accounts", "list"], (known) => {
            if (!known) return known;
            const before = known.find((entry) => entry.id === account.id);
            if (before && before.quota.observedAt > account.quota.observedAt) return known;
            return before
              ? known.map((entry) => (entry.id === account.id ? account : entry))
              : [...known, account];
          });
          void queryClient.invalidateQueries({ queryKey: ["providers", "statuses"] });
          return;
        }
        if (message.type !== "providers.changed") return;
        queryClient.setQueryData(readinessKey, message.providers);
        for (const queryKey of dependentKeys) void queryClient.invalidateQueries({ queryKey });
      }),
      connection.subscribe(() => {
        const now = connection.getSnapshot() === "ready";
        if (now && !ready) refreshProviders(queryClient);
        ready = now;
      }),
    ];
    const created = {
      users: 0,
      stop() {
        for (const stop of stops) stop();
        watchers.delete(client);
      },
    };
    watchers.set(client, created);
    watcher = created;
  }
  const active = watcher;
  active.users++;
  return () => {
    if (--active.users === 0) active.stop();
  };
}

/** Keep provider descriptions current while the calling component is mounted. */
export function useProvidersWatch(): void {
  const client = useClient();
  const queryClient = useQueryClient();
  useEffect(() => watchProviders(client, queryClient), [client, queryClient]);
}

/** Every provider's readiness, live; undefined until it arrives. */
export function useProviderReadiness() {
  useProvidersWatch();
  return useDaemonQuery({ queryKey: readinessKey, read: readReadiness });
}

/** This device's first-run checklist, live. */
export function useOnboarding(options: { enabled?: boolean } = {}) {
  useProvidersWatch();
  return useDaemonQuery({ queryKey: onboardingKey, read: readOnboarding, ...options });
}

/** Mark first-run setup done (or not) for this device; the checklist reads it back. */
export async function dismissOnboarding(
  client: ClientApi,
  queryClient: QueryClient,
  dismissed: boolean,
): Promise<void> {
  queryClient.setQueryData<Onboarding>(onboardingKey, (known) => known && { ...known, dismissed });
  try {
    const reply = await client.request({ type: "onboarding.dismiss", dismissed });
    if (reply.result.ok) queryClient.setQueryData(onboardingKey, reply.result);
  } catch {
    // A read-only device can't record it: setup stays dismissed for this visit only.
  }
}
