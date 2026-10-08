import { LocalStore } from "../store.ts";

/*
 * The browser tabs' shared session state, small enough to load with the tab kinds: the pages'
 * bookkeeping, how a closed tab's page closes, and which tabs are loading.
 */

/**
 * The pages' bookkeeping for one connection to the daemon (page ids are the daemon session's,
 * so a new connection starts clean). Per thread: the tab waiting for the page it asked the
 * daemon to open, the pages whose tab the person closed while the page stayed open (the
 * thread's last page stays for its agents; no tab opens for them again by itself), and the
 * active page the tabs last followed.
 */
export interface PageSession {
  opening: LocalStore<ReadonlyMap<string, string>>;
  dismissed: LocalStore<ReadonlyMap<string, ReadonlySet<string>>>;
  followed: Map<string, string>;
}

const sessions = new WeakMap<object, PageSession>();

export function pageSession(source: object): PageSession {
  let session = sessions.get(source);
  if (!session) {
    session = {
      opening: new LocalStore(new Map()),
      dismissed: new LocalStore(new Map()),
      followed: new Map(),
    };
    sessions.set(source, session);
  }
  return session;
}

export function setOpening(session: PageSession, threadId: string, tabKey: string | undefined) {
  session.opening.set((current) => {
    if (current.get(threadId) === tabKey) return current;
    const next = new Map(current);
    if (tabKey) next.set(threadId, tabKey);
    else next.delete(threadId);
    return next;
  });
}

export function setDismissed(
  session: PageSession,
  threadId: string,
  page: string,
  dismissed: boolean,
) {
  session.dismissed.set((current) => {
    const pages = current.get(threadId) ?? new Set<string>();
    if (pages.has(page) === dismissed) return current;
    const next = new Set(pages);
    if (dismissed) next.add(page);
    else next.delete(page);
    return new Map(current).set(threadId, next);
  });
}

/**
 * How each thread's pages close when their tab does, registered by the browser view (which has
 * the daemon connection) and kept after it unmounts.
 */
const closers = new Map<string, (page: string) => void>();

export function registerPageCloser(threadId: string, close: (page: string) => void) {
  closers.set(threadId, close);
}

/** A browser tab showing `page` closed: close the page too, or keep it out of the tabs. */
export function closePage(threadId: string, page: string) {
  closers.get(threadId)?.(page);
}

/** Browser tabs with a navigation in flight (`threadId\0tabKey`), for their strip spinner. */
export const loadingTabs = new LocalStore<ReadonlySet<string>>(new Set());

export const loadingKey = (threadId: string, tabKey: string) => `${threadId}\u0000${tabKey}`;

export function setLoading(threadId: string, tabKey: string, loading: boolean) {
  const key = loadingKey(threadId, tabKey);
  loadingTabs.set((current) => {
    if (current.has(key) === loading) return current;
    const next = new Set(current);
    if (loading) next.add(key);
    else next.delete(key);
    return next;
  });
}

/** A fresh id for a new browser tab of a scope: one past the highest in use. */
export function nextBrowserId(keys: readonly string[]): string {
  const taken = keys
    .filter((key) => key.startsWith("browser:"))
    .map((key) => Number(key.slice("browser:".length)) || 0);
  return String(Math.max(0, ...taken) + 1);
}
