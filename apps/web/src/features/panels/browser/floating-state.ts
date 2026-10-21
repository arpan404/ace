import { LocalStore } from "../store.ts";

/*
 * What decides which threads' pages float in picture-in-picture, shared by every thread's
 * browser and the app-wide floating windows (`floating-browsers.tsx`). Kept for the session.
 */

type Threads = ReadonlySet<string>;

/** Threads whose Browser the person has looked at in the panel: only those pages follow them. */
export const seenBrowsers = new LocalStore<Threads>(new Set());
/** Threads whose Browser shows in a panel on screen now. */
export const browsersOnScreen = new LocalStore<Threads>(new Set());
/** Threads whose floating page the person closed, until their Browser shows again. */
export const dismissedPip = new LocalStore<Threads>(new Set());
/** Threads whose page floats now. */
export const floatingThreads = new LocalStore<Threads>(new Set());

export function addThread(store: LocalStore<Threads>, threadId: string): void {
  if (!store.get().has(threadId)) store.set((threads) => new Set(threads).add(threadId));
}

export function removeThread(store: LocalStore<Threads>, threadId: string): void {
  if (!store.get().has(threadId)) return;
  store.set((threads) => new Set([...threads].filter((id) => id !== threadId)));
}

/**
 * The threads that may float now, in the order the person first looked at their Browser: each
 * one they have looked at, whose Browser isn't on screen and whose window they haven't closed,
 * while an agent browses there. The open thread's page may also float for its sound, which
 * only its own view knows, so it is always a candidate. None on a phone, none when picture in
 * picture is turned off.
 */
export function floatingCandidates(input: {
  current: string | undefined;
  seen: Threads;
  onScreen: Threads;
  dismissed: Threads;
  browsing: Threads;
  enabled: boolean;
  phone: boolean;
}): string[] {
  if (!input.enabled || input.phone) return [];
  return [...input.seen].filter(
    (id) =>
      !input.onScreen.has(id) &&
      !input.dismissed.has(id) &&
      (id === input.current || input.browsing.has(id)),
  );
}

/** The floating window the person touched last: it draws above the others. */
export const frontPip = new LocalStore<string | undefined>(undefined);
