import type { BrowserTab } from "@ace/protocol";
import type {
  BackendOpen,
  BrowserBackend,
  BrowserBackendPage,
  BrowserBackendSession,
  BrowserBackendTabs,
  BrowserCdp,
} from "./backend.ts";
import type { UserChromeBackend, UserTabRef } from "./user-chrome.ts";

/** One tab of a thread's browser in the person's Chrome. */
interface Entry {
  /** A tab the person shared; absent for a tab an agent opened in the ace window. */
  shared?: UserTabRef;
  /** Attached: an agent tab always, a shared tab once a command first used it. */
  session?: BrowserBackendSession;
  claiming?: Promise<BrowserBackendSession> | undefined;
  page: BrowserBackendPage;
}

const sharedId = (ref: UserTabRef) => `shared-${ref.connectionId}-${ref.tabId}`;
const lastTab = "Close the browser to close its last tab";

/**
 * The person's own browser (ADR 0084) as a multi-tab backend for one thread (ADR 0083): the
 * agents' tabs in the ace window, plus every tab the person shared, listed as opened by them.
 * A shared tab is attached (claimed) only when a command first uses it, so listing tabs never
 * takes the person's tab. The tab shown to ace's own viewers is always an agent tab.
 */
export class UserChromeTabsBackend implements BrowserBackend {
  readonly kind = "user";
  private user: UserChromeBackend;
  constructor(user: UserChromeBackend) {
    this.user = user;
  }
  open(request: BackendOpen): Promise<BrowserBackendSession> {
    return new UserTabs(this.user, request).start();
  }
}

class UserTabs {
  private agents = new Map<string, Entry>();
  private claimed = new Map<string, Entry>();
  /** Shared tabs this thread let go of; listed again once the person shares them anew. */
  private released = new Set<string>();
  private activeId = "";
  private sequence = 0;
  private closed = false;
  private stopWatching = () => {};
  private user: UserChromeBackend;
  private request: BackendOpen;
  constructor(user: UserChromeBackend, request: BackendOpen) {
    this.user = user;
    this.request = request;
  }
  async start(): Promise<BrowserBackendSession> {
    this.activeId = await this.openAgent();
    this.stopWatching = this.user.onChange(() => {
      if (this.closed) return;
      const shared = new Set(this.user.sharedTabs().map(sharedId));
      for (const id of this.released) if (!shared.has(id)) this.released.delete(id);
      for (const [id, entry] of this.claimed)
        if (!entry.session && !entry.claiming && !shared.has(id)) this.claimed.delete(id);
      this.request.changed?.();
    });
    return this.session();
  }
  /** What one tab's session reports, attributed to that tab. */
  private tabRequest(id: string): BackendOpen {
    return {
      ...this.request,
      navigation: () => this.request.navigation(id),
      log: (entry) => this.request.log({ ...entry, tabId: id }),
      lost: (reason) => this.tabLost(id, reason),
    };
  }
  private async openAgent(): Promise<string> {
    const id = `agent-${++this.sequence}`;
    const session = await this.user.open(this.tabRequest(id));
    if (this.closed) {
      await session.close();
      throw new Error("Browser closed");
    }
    this.agents.set(id, { session, page: session });
    return id;
  }
  /**
   * A tab went away in the person's browser (closed, un-shared, Stop, a lost link). The thread
   * keeps its other tabs; with no agent tab left, the whole session is lost and closes. It is
   * never moved to another browser: the person's logins would not come with it.
   */
  private tabLost(id: string, reason: string): void {
    if (this.closed) return;
    this.claimed.delete(id);
    if (!this.agents.has(id)) {
      this.request.changed?.();
      return;
    }
    // The last agent tab stays listed, dead, while the session that owned it closes.
    if (this.agents.size === 1) {
      this.request.lost(reason);
      return;
    }
    this.agents.delete(id);
    if (this.activeId === id) this.activeId = this.agents.keys().next().value ?? "";
    this.request.changed?.();
  }
  private shared(): (UserTabRef & { tab: { url: string; title: string } })[] {
    return this.user.sharedTabs().filter((ref) => !this.released.has(sharedId(ref)));
  }
  private list(): BrowserTab[] {
    return [
      ...[...this.agents].map(([tabId, entry]) => ({
        tabId,
        url: entry.page.url(),
        title: "",
      })),
      ...this.shared().map((ref) => ({
        tabId: sharedId(ref),
        url: ref.tab.url,
        title: ref.tab.title,
        openedBy: { kind: "human" as const },
      })),
    ];
  }
  private page(id: string): BrowserBackendPage {
    const entry = this.agents.get(id) ?? this.claimed.get(id);
    if (entry) return entry.page;
    const ref = this.shared().find((candidate) => sharedId(candidate) === id);
    if (!ref) throw new Error("Browser tab unavailable");
    return this.sharedPage(id, ref);
  }
  /** A shared tab's page, attached on its first command. */
  private sharedPage(id: string, ref: UserTabRef): BrowserBackendPage {
    const listeners: [string, (params: unknown) => void][] = [];
    const attach = (): Promise<BrowserBackendSession> => {
      if (entry.session) return Promise.resolve(entry.session);
      entry.claiming ??= this.user.claim(this.tabRequest(id), ref).then(
        async (session) => {
          if (this.closed || this.claimed.get(id) !== entry) {
            await session.close();
            throw new Error("Browser tab unavailable");
          }
          entry.session = session;
          for (const [method, listener] of listeners) session.cdp.on(method, listener);
          return session;
        },
        (error: unknown) => {
          entry.claiming = undefined;
          throw error;
        },
      );
      return entry.claiming;
    };
    const cdp: BrowserCdp = {
      send: async (method, params) => (await attach()).cdp.send(method, params),
      on: (method, listener) => {
        listeners.push([method, listener]);
        entry.session?.cdp.on(method, listener);
      },
      off: (method, listener) => {
        const index = listeners.findIndex(([m, l]) => m === method && l === listener);
        if (index >= 0) listeners.splice(index, 1);
        entry.session?.cdp.off(method, listener);
      },
    };
    const page: BrowserBackendPage = {
      cdp,
      pageStatus: () => entry.session?.pageStatus?.() ?? { loading: false },
      url: () =>
        entry.session?.url() ??
        this.user.sharedTabs().find((candidate) => sharedId(candidate) === id)?.tab.url ??
        "about:blank",
      navigate: async (url, timeout, signal) => (await attach()).navigate(url, timeout, signal),
      click: async (x, y) => (await attach()).click(x, y),
      insertText: async (text) => (await attach()).insertText(text),
      press: async (key) => (await attach()).press(key),
      wheel: async (x, y) => (await attach()).wheel(x, y),
      screenshot: async (format) => (await attach()).screenshot(format),
      resize: async (width, height) => (await attach()).resize(width, height),
      viewport: () => entry.session?.viewport() ?? { width: 1280, height: 720 },
      media: async (scheme) => (await attach()).media(scheme),
    };
    const entry: Entry = { shared: ref, page };
    this.claimed.set(id, entry);
    return page;
  }
  private tabs(): BrowserBackendTabs {
    return {
      list: () => this.list(),
      active: () => this.activeId,
      open: async (options) => {
        const id = await this.openAgent();
        if (!options?.background) this.activeId = id;
        this.request.changed?.();
        return id;
      },
      // ace's viewers watch an agent tab; a shared tab is on the person's own screen already.
      switch: async (id) => {
        if (this.agents.has(id)) this.activeId = id;
        this.request.changed?.();
      },
      close: async (id) => {
        const agent = this.agents.get(id);
        if (agent) {
          if (this.agents.size === 1) throw new Error(lastTab);
          this.agents.delete(id);
          if (this.activeId === id) this.activeId = this.agents.keys().next().value ?? "";
          await agent.session?.close();
        } else {
          // The person's tab stays open; this thread only lets go of it.
          const entry = this.claimed.get(id);
          this.claimed.delete(id);
          this.released.add(id);
          await entry?.session?.close();
        }
        this.request.changed?.();
      },
      dialog: () => undefined,
      answer: () => Promise.reject(new Error("Dialogs in your own browser are yours to answer")),
      downloads: () => [],
      page: (id) => this.page(id),
    };
  }
  private session(): BrowserBackendSession {
    const current = () => this.page(this.activeId);
    return {
      get cdp() {
        return current().cdp;
      },
      tabs: this.tabs(),
      pageStatus: () => current().pageStatus?.() ?? { loading: false },
      url: () => current().url(),
      navigate: (url, timeout, signal) => current().navigate(url, timeout, signal),
      click: (x, y) => current().click(x, y),
      insertText: (text) => current().insertText(text),
      press: (key) => current().press(key),
      wheel: (x, y) => current().wheel(x, y),
      screenshot: (format) => current().screenshot(format),
      resize: (width, height) => current().resize(width, height),
      viewport: () => current().viewport(),
      media: (scheme) => current().media(scheme),
      close: () => this.close(),
    };
  }
  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    const entries = [...this.agents.values(), ...this.claimed.values()];
    this.agents.clear();
    this.claimed.clear();
    await Promise.allSettled(entries.map((entry) => entry.session?.close()));
  }
}
