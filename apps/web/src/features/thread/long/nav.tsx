import type { ThreadReader, ThreadSource } from "@ace/client";
import { useClient, useItemOrder, useThread, useThreadStore } from "@ace/client-react";
import { inRootLane } from "@ace/projection";
import { itemTurnOrdinals } from "@ace/ui-core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { JumpSnapshot, LiveTail } from "./jump-controller.ts";
import { Jump } from "./jump.ts";
import { useTurnRefresh } from "./turn-refresh.ts";

/*
 * Navigation state of one open thread: the jump controller (a window of older history beside
 * the live tail), which long-thread tools are open, and two small values the transcript
 * reports as the reader scrolls (the turn at the top, and whether it follows the live end).
 * Those two are external stores so a scroll re-renders only what reads them.
 */

/** A value that notifies only when it changes. */
export class Watched<T> {
  private value: T;
  private listeners = new Set<() => void>();
  constructor(value: T) {
    this.value = value;
  }
  get = (): T => this.value;
  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export interface ThreadNav {
  threadId: string;
  jump: Jump;
  /** The root turn at the top of the transcript's viewport. */
  currentTurn: Watched<number | undefined>;
  /** The root turn at the bottom of the viewport: with `currentTurn`, every turn in view. */
  bottomTurn: Watched<number | undefined>;
  /** The reader is at the live end and new output scrolls into view. */
  following: Watched<boolean>;
  /** The newest root turn the live tail shows: the turn index is read again when it moves. */
  liveTurn: Watched<number | undefined>;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  /** Bumped by ⌘F, so an open search bar takes focus again. */
  searchFocus: Watched<number>;
  /**
   * The reader followed a joined window to the live end. The thread's transcript goes back to
   * the tail alone; a subagent's keeps holding its lane, which busy siblings would trim.
   */
  leaveWindow(): void;
}

const NavContext = createContext<ThreadNav | undefined>(undefined);

/** The newest root turn among the live tail's items. */
function readLiveTurn(reader: ThreadReader): number | undefined {
  let newest: number | undefined;
  for (const ordinal of itemTurnOrdinals(reader))
    if (ordinal !== undefined && (newest === undefined || ordinal > newest)) newest = ordinal;
  return newest;
}

/** Where root turn `ordinal` starts in the live tail, if the tail holds it. */
function firstItemOf(live: ThreadSource | undefined, ordinal: number): string | undefined {
  if (!live) return undefined;
  const ordinals = itemTurnOrdinals(live);
  const index = ordinals.indexOf(ordinal);
  return index < 0 ? undefined : live.order[index];
}

/** The tail as a transcript's window reads it: the root's lane, or one subagent's. */
function laneTail(live: ThreadSource | undefined, agentId: string | undefined): () => LiveTail {
  const shared = {
    order: live?.order ?? [],
    before: live?.itemsBefore,
    seq: (id: string) => live?.itemSeq?.(id),
    item: (id: string) => live?.item(id),
  };
  if (agentId === undefined)
    return () => ({
      ...shared,
      firstItemOf: (ordinal) => firstItemOf(live, ordinal),
      inLane: (id) => inRootLane(live?.item(id)?.agentId, live?.thread?.rootAgentId),
    });
  return () => ({
    ...shared,
    firstItemOf: () => undefined,
    inLane: (id) => live?.item(id)?.agentId === agentId,
    itemInLane: (item) => item.agentId === agentId,
  });
}

/**
 * One transcript's navigation: the thread's, or with `agentId` one provider subagent's lane
 * of it. A subagent's lane always reads through a held window, so siblings streaming into the
 * shared, bounded tail never trim its rows from under the reader.
 */
export function ThreadNavProvider(props: {
  threadId: string;
  agentId?: string | undefined;
  children: ReactNode;
}) {
  const client = useClient();
  const { agentId } = props;
  const live = useThreadStore(props.threadId);
  useTurnRefresh(live, props.threadId);
  const [jump] = useState(() => new Jump(client, props.threadId));
  useEffect(() => {
    // Reads the store when called: the tail as it is then.
    jump.setTail(() => laneTail(live, agentId)());
  }, [jump, live, agentId]);
  useEffect(() => () => jump.dispose(), [jump]);
  const [currentTurn] = useState(() => new Watched<number | undefined>(undefined));
  const [bottomTurn] = useState(() => new Watched<number | undefined>(undefined));
  const [following] = useState(() => new Watched(true));
  // The reader leaving the live end holds the rows they see: the shared tail is bounded and
  // trims its oldest items as output arrives, and must never trim them from under the reader.
  useEffect(
    () =>
      following.subscribe(() => {
        if (!following.get()) jump.hold();
        else if (agentId !== undefined) jump.follow();
      }),
    [following, jump, agentId],
  );
  // A subagent's lane is held whenever no window is open, as the tail moves.
  const tailEnd = useItemOrder(props.threadId)?.at(-1);
  const held = !!useJumpState(jump).window;
  useEffect(() => {
    if (agentId === undefined || held || !live || tailEnd === undefined) return;
    void jump.holdLane();
  }, [jump, agentId, held, live, tailEnd]);
  const [liveTurn] = useState(() => new Watched<number | undefined>(undefined));
  const newestTurn = useThread(props.threadId, ["order", "agents"], readLiveTurn);
  useEffect(() => liveTurn.set(newestTurn), [liveTurn, newestTurn]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus] = useState(() => new Watched(0));
  const leaveWindow = useCallback(
    () => (agentId === undefined ? jump.live() : jump.follow()),
    [jump, agentId],
  );
  const value = useMemo<ThreadNav>(
    () => ({
      threadId: props.threadId,
      jump,
      currentTurn,
      bottomTurn,
      following,
      liveTurn,
      searchOpen,
      setSearchOpen,
      searchFocus,
      leaveWindow,
    }),
    [
      props.threadId,
      jump,
      currentTurn,
      bottomTurn,
      following,
      liveTurn,
      searchOpen,
      searchFocus,
      leaveWindow,
    ],
  );
  return <NavContext.Provider value={value}>{props.children}</NavContext.Provider>;
}

export function useThreadNav(): ThreadNav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useThreadNav needs a <ThreadNavProvider>");
  return nav;
}

/** The thread's navigation when there is one (the agent tab's transcript has none). */
export function useOptionalThreadNav(): ThreadNav | undefined {
  return useContext(NavContext);
}

export function useJumpState(jump: Jump): JumpSnapshot {
  return useSyncExternalStore(jump.subscribe, jump.snapshot, jump.snapshot);
}

export function useWatched<T>(watched: Watched<T>): T {
  return useSyncExternalStore(watched.subscribe, watched.get, watched.get);
}
