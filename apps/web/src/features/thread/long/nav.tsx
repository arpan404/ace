import type { ThreadSource } from "@ace/client";
import { useClient, useThreadStore } from "@ace/client-react";
import { itemTurnOrdinals } from "@ace/ui-core";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { JumpController, type JumpSnapshot } from "./jump-controller.ts";

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
  jump: JumpController;
  /** The root turn at the top of the transcript's viewport. */
  currentTurn: Watched<number | undefined>;
  /** The reader is at the live end and new output scrolls into view. */
  following: Watched<boolean>;
  turnsOpen: boolean;
  setTurnsOpen(open: boolean): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  /** Bumped by ⌘F, so an open search bar takes focus again. */
  searchFocus: Watched<number>;
}

const NavContext = createContext<ThreadNav | undefined>(undefined);

/** Where root turn `ordinal` starts in the live tail, if the tail holds it. */
function firstItemOf(live: ThreadSource | undefined, ordinal: number): string | undefined {
  if (!live) return undefined;
  const ordinals = itemTurnOrdinals(live);
  const index = ordinals.indexOf(ordinal);
  return index < 0 ? undefined : live.order[index];
}

export function ThreadNavProvider(props: { threadId: string; children: ReactNode }) {
  const client = useClient();
  const live = useThreadStore(props.threadId);
  const [jump] = useState(() => new JumpController(client, props.threadId));
  useEffect(
    () =>
      jump.setTail(() => ({
        order: live?.order ?? [],
        before: live?.itemsBefore,
        firstItemOf: (ordinal) => firstItemOf(live, ordinal),
      })),
    [jump, live],
  );
  useEffect(() => () => jump.dispose(), [jump]);
  const [currentTurn] = useState(() => new Watched<number | undefined>(undefined));
  const [following] = useState(() => new Watched(true));
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus] = useState(() => new Watched(0));
  const value = useMemo<ThreadNav>(
    () => ({
      threadId: props.threadId,
      jump,
      currentTurn,
      following,
      turnsOpen,
      setTurnsOpen,
      searchOpen,
      setSearchOpen,
      searchFocus,
    }),
    [props.threadId, jump, currentTurn, following, turnsOpen, searchOpen, searchFocus],
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

export function useJumpState(jump: JumpController): JumpSnapshot {
  return useSyncExternalStore(jump.subscribe, jump.snapshot, jump.snapshot);
}

export function useWatched<T>(watched: Watched<T>): T {
  return useSyncExternalStore(watched.subscribe, watched.get, watched.get);
}
