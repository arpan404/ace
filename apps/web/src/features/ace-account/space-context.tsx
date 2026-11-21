import { AceOrgError, type AceOrgClient } from "@ace/client/ace-org";
import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AceAccountStore } from "./session-store.ts";
import { personalSpace, shownSpace, type ShownSpace } from "./spaces.ts";

/** Every organization read, so leaving or a refused membership drops them together. */
export const orgKey = ["ace-org"] as const;

export interface SpaceState {
  /** The person's organizations; undefined while signed out, unknown or without a backend. */
  spaces: readonly AceOrgSpace[] | undefined;
  /** The space this window shows; undefined only while a chosen organization is being checked. */
  shown: ShownSpace | undefined;
  choose(space: string): void;
  /** The organizations' hosts by organization, as far as they are known. */
  hostsOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** The backend's org calls with the window's session, or undefined signed out. */
  calls: { orgs: AceOrgClient; token: string } | undefined;
  /** The organization whose sign-in policy wants a new sign-in (`org_sign_in_required`). */
  signInNeeded: string | undefined;
  /** An org call failed: ended sessions, memberships that changed and sign-in policies follow. */
  failed(error: unknown): void;
  /** The list again, after creating, leaving or joining. */
  refresh(): Promise<void>;
  error: unknown;
}

const noSubscription = () => () => {};

/**
 * Each organization's hosts that answered, by organization. A failed read places nothing: its
 * hosts stay out of every space until it answers. Module-level, so the map changes only when an
 * answer does.
 */
function hostsByOrg(
  results: readonly { data?: { org: string; hosts: readonly { hostId: string }[] } | undefined }[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const { data } of results)
    if (data) map.set(data.org, new Set(data.hosts.map((host) => host.hostId)));
  return map;
}
const noHosts: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const signedOut: SpaceState = {
  spaces: undefined,
  shown: { id: personalSpace, org: undefined },
  choose() {},
  hostsOf: noHosts,
  calls: undefined,
  signInNeeded: undefined,
  failed() {},
  refresh: async () => {},
  error: undefined,
};

const SpaceContext = createContext<SpaceState>(signedOut);

/**
 * The window's space (ADR 0206 §1.5): kept in the window's own storage, per account, so each
 * window shows its own and a reload keeps it. Reads that hold a space's data are keyed by the
 * space, so switching never draws one space's rows in another; switching and leaving delete
 * nothing.
 */
export function SpaceProvider(props: { store: AceAccountStore | undefined; children: ReactNode }) {
  const { store } = props;
  const session = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store?.get().session ?? null,
  );
  const orgs = store?.orgs;
  const token = session?.token;
  const account = session?.account.id;
  const queryClient = useQueryClient();
  const choiceKey = store && account ? `ace.space:${store.origin}:${account}` : undefined;
  // Bumped by `choose`, so the window's choice is read again.
  const [, setVersion] = useState(0);
  const [signInNeeded, setSignInNeeded] = useState<string>();
  const chosen =
    choiceKey && store ? (store.storage.getItem(choiceKey) ?? personalSpace) : personalSpace;
  const listKey = [...orgKey, "spaces", store?.origin, account] as const;
  const list = useQuery({
    queryKey: listKey,
    enabled: Boolean(orgs && token),
    staleTime: 30_000,
    retry: (count, error) => !(error instanceof AceOrgError && error.status < 500) && count < 1,
    queryFn: async ({ signal }) => {
      if (!orgs || !token) return [];
      try {
        return await orgs.spaces(token, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      } catch (error) {
        if (error instanceof AceOrgError && error.status === 401) await store?.ended();
        throw error;
      }
    },
  });
  const spaces = orgs && token ? list.data : undefined;
  const hostsOf = useQueries({
    queries: (spaces ?? []).map((space) => ({
      queryKey: [...orgKey, "hosts", store?.origin, account, space.id],
      staleTime: 60_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => ({
        org: space.id,
        hosts:
          orgs && token
            ? await orgs.hosts(
                token,
                space.id,
                AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              )
            : [],
      }),
    })),
    combine: hostsByOrg,
  });
  const refused = list.isError;
  const shown = useMemo(
    () => (orgs && token ? shownSpace(chosen, refused ? [] : spaces) : signedOut.shown),
    [orgs, token, chosen, refused, spaces],
  );
  // Left or removed: the space is gone from the list, and from the window's choice.
  useEffect(() => {
    if (!choiceKey || !store || chosen === personalSpace || !spaces) return;
    if (!spaces.some((space) => space.id === chosen)) store.storage.removeItem?.(choiceKey);
  }, [choiceKey, store, chosen, spaces]);
  const choose = useCallback(
    (space: string) => {
      if (!choiceKey || !store) return;
      store.storage.setItem(choiceKey, space);
      setVersion((at) => at + 1);
    },
    [choiceKey, store],
  );
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: orgKey });
  }, [queryClient]);
  const failed = useCallback(
    (error: unknown) => {
      if (!(error instanceof AceOrgError)) return;
      if (error.status === 401) void store?.ended();
      else if (error.code === "org_sign_in_required") setSignInNeeded(error.org);
      // WorkOS no longer counts the person in: the list says what remains. Only the list: the
      // organization's own reads would be refused again.
      else if (error.code === "not_member")
        void queryClient.invalidateQueries({
          queryKey: [...orgKey, "spaces", store?.origin, account],
        });
    },
    [store, queryClient, account],
  );
  const value = useMemo<SpaceState>(
    () => ({
      spaces,
      shown,
      choose,
      hostsOf,
      calls: orgs && token ? { orgs, token } : undefined,
      signInNeeded,
      failed,
      refresh,
      error: list.error,
    }),
    [spaces, shown, choose, hostsOf, orgs, token, signInNeeded, failed, refresh, list.error],
  );
  return <SpaceContext value={value}>{props.children}</SpaceContext>;
}

/** The window's space and the person's organizations. */
export function useSpace(): SpaceState {
  return use(SpaceContext);
}
