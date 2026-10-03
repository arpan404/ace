// TODO(train-2): wire to protocol when merged. Mentions, CI and pull-request events (forge,
// ADR 0016) and Deck escalations (ADR 0017) have no daemon wire messages on main yet, so the
// feed is served by an in-memory source with realistic content. Components depend only on
// `FeedSource`; swapping in the daemon changes this file alone.
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useSyncExternalStore } from "react";

export type FeedKind = "escalation" | "mention" | "ci" | "pr";

export interface FeedAction {
  id: string;
  label: string;
  primary?: boolean;
}
export interface FeedEvent {
  id: string;
  kind: FeedKind;
  title: string;
  /** Project, or "Deck" for escalations. */
  project: string;
  /** The thread or deck title, plus detail ("2 failing"). */
  context: string;
  at: number;
  threadId?: string;
  outcome?: "failed" | "done";
  /** Escalations: the explanation and the choices offered. Open until one is taken. */
  body?: string;
  actions?: readonly FeedAction[];
  resolved?: boolean;
}
export interface FeedSnapshot {
  events: readonly FeedEvent[];
  /** Ids read on this device: feed events and automation runs share the set. */
  read: ReadonlySet<string>;
}
export interface FeedSource {
  subscribe(listener: () => void): () => void;
  snapshot(): FeedSnapshot;
  markRead(ids: readonly string[]): void;
  /** Take one of an escalation's actions; it leaves Needs you once accepted. */
  resolve(eventId: string, actionId: string): Promise<void>;
}

const minute = 60_000;

/** The approved design's feed, timed relative to `now`. */
export function seedFeed(now: number): FeedEvent[] {
  return [
    {
      id: "feed-escalation-cold-start",
      kind: "escalation",
      title: "Lane failed review twice: Mobile cold-start replay",
      project: "Deck",
      context: "Resumable relay streams",
      at: now - 22 * minute,
      body: "The reviewer keeps rejecting the lane because it cannot run the iOS simulator on build-box. The deck suggests moving the lane to this Mac or splitting the simulator test into its own card.",
      actions: [
        { id: "split", label: "Split the lane" },
        { id: "move", label: "Move to this Mac", primary: true },
      ],
    },
    {
      id: "feed-mention-docker-port",
      kind: "mention",
      title: "@you Which port does the daemon default to in docker?",
      project: "docs-site",
      context: "Rewrite the install page for the daemon",
      at: now - 31 * minute,
      threadId: "thread-install-page",
    },
    {
      id: "feed-ci-74",
      kind: "ci",
      title: "Tests failed on #74",
      project: "billing-api",
      context: "Invoice PDF locale fallback · 2 failing",
      at: now - 26 * minute,
      threadId: "thread-pdf-locale",
      outcome: "failed",
    },
    {
      id: "feed-pr-212",
      kind: "pr",
      title: "PR #212 merged",
      project: "ace",
      context: "Bump Codex app-server to 0.48",
      at: now - 41 * minute,
      threadId: "thread-bump-codex",
      outcome: "done",
    },
  ];
}

export function memoryFeedSource(events: FeedEvent[]): FeedSource {
  let state: FeedSnapshot = { events, read: new Set() };
  const listeners = new Set<() => void>();
  const set = (next: FeedSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
    markRead(ids) {
      if (ids.every((id) => state.read.has(id))) return;
      set({ ...state, read: new Set([...state.read, ...ids]) });
    },
    async resolve(eventId, actionId) {
      const event = state.events.find((candidate) => candidate.id === eventId);
      if (!event?.actions?.some((action) => action.id === actionId)) throw new Error("not_found");
      if (event.resolved) throw new Error("already_resolved");
      set({
        events: state.events.map((candidate) =>
          candidate === event ? { ...candidate, resolved: true } : candidate,
        ),
        read: new Set([...state.read, eventId]),
      });
    },
  };
}

// One source per daemon client, so each connection (and each test) starts from the seed.
const sources = new WeakMap<ClientApi, FeedSource>();

export function useFeedSource(): FeedSource {
  const client = useClient();
  let source = sources.get(client);
  if (!source) {
    source = fakeFeedSource();
    sources.set(client, source);
  }
  return source;
}

/** The in-memory stand-in, seeded with the design's feed at the wall clock. */
function fakeFeedSource(): FeedSource {
  return memoryFeedSource(seedFeed(Date.now()));
}

export function useFeed(): FeedSnapshot {
  const source = useFeedSource();
  return useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
}
