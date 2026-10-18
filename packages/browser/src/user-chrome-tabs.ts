import type { BrowserDialog, BrowserTab } from "@ace/protocol";
import type {
  BackendOpen,
  BackendRestoreTab,
  BrowserBackend,
  BrowserBackendPage,
  BrowserBackendSession,
  BrowserBackendTabs,
  BrowserCdp,
} from "./backend.ts";
import type { UserChromeBackend, UserTabRef } from "./user-chrome.ts";
import type { UserTabSession } from "./user-chrome-session.ts";

/** One tab of a thread's browser in the person's Chrome. */
interface Entry {
  /** A tab the person shared; absent for a tab an agent opened in the ace window. */
  shared?: UserTabRef;
  /** An agent tab: where it is in the person's browser. */
  ref?: UserTabRef;
  /** A popup: the thread's tab whose page opened it. */
  opener?: string;
  /** Attached: an agent tab always, a shared tab once a command first used it. */
  session?: UserTabSession;
  claiming?: Promise<UserTabSession> | undefined;
  page: BrowserBackendPage;
  /** An agent tab's place in the daemon-wide tab budget. */
  release?: () => void;
}

const sharedId = (ref: UserTabRef) => `shared-${ref.connectionId}-${ref.tabId}`;
const refKey = (ref: UserTabRef) => `${ref.connectionId}-${ref.tabId}`;
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
  /** Agent tabs some thread holds (`refKey`), so two threads never take back the same one. */
  private held = new Set<string>();
  constructor(user: UserChromeBackend) {
    this.user = user;
  }
  open(request: BackendOpen): Promise<BrowserBackendSession> {
    return new UserTabs(this.user, request, this.held).start();
  }
}

class UserTabs {
  private agents = new Map<string, Entry>();
  private claimed = new Map<string, Entry>();
  /** Shared tabs this thread let go of; listed again once the person shares them anew. */
  private released = new Set<string>();
  /** Popups being adopted, or that could not be, by `refKey`. */
  private adopting = new Set<string>();
  private refused = new Set<string>();
  private activeId = "";
  private sequence = 0;
  private closed = false;
  private stopWatching = () => {};
  private user: UserChromeBackend;
  private request: BackendOpen;
  private held: Set<string>;
  constructor(user: UserChromeBackend, request: BackendOpen, held: Set<string>) {
    this.user = user;
    this.request = request;
    this.held = held;
  }
  async start(): Promise<BrowserBackendSession> {
    this.activeId = (await this.restore()) ?? (await this.openAgent());
    this.stopWatching = this.user.onChange(() => {
      if (this.closed) return;
      const shared = new Set(this.user.sharedTabs().map(sharedId));
      for (const id of this.released) if (!shared.has(id)) this.released.delete(id);
      for (const [id, entry] of this.claimed)
        if (!entry.session && !entry.claiming && !shared.has(id)) this.claimed.delete(id);
      this.adoptPopups();
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
  /** A place in the daemon-wide tab budget: agent tabs here count as ace's own do. */
  private reserve(): () => void {
    return this.request.reserveTab?.() ?? (() => {});
  }
  /**
   * The thread's agent tabs from before a restart, with their ids, in order: each takes back a
   * still-open agent tab at its address in the person's browser, or opens one there. Returns
   * the first, which is shown. Tabs the person shared come back when they are listed again.
   */
  private async restore(): Promise<string | undefined> {
    let first: string | undefined;
    const entries = (this.request.restoreTabs ?? []).filter(
      (entry) => !entry.tabId.startsWith("shared-"),
    );
    for (const entry of entries.slice(0, this.request.maxTabs ?? 16)) {
      try {
        const id = await this.reopen(entry);
        first ??= id;
      } catch {
        // That tab stays gone; the others still come back.
      }
    }
    return first;
  }
  private async reopen(entry: BackendRestoreTab): Promise<string> {
    const numbered = /^agent-(\d+)$/.exec(entry.tabId);
    if (numbered) this.sequence = Math.max(this.sequence, Number(numbered[1]));
    const left = this.user
      .agentTabs()
      .find((ref) => ref.tab.url === entry.url && !this.held.has(refKey(ref)));
    if (!left) {
      const id = await this.openAgent(entry.tabId);
      const page = this.agents.get(id)?.page;
      if (page && entry.url !== "about:blank")
        await page.navigate(entry.url, 30_000, this.request.signal).catch(() => {});
      return id;
    }
    const release = this.reserve();
    this.held.add(refKey(left));
    try {
      const session = await this.user.adopt(this.tabRequest(entry.tabId), left);
      if (this.closed) {
        await session.close();
        throw new Error("Browser closed");
      }
      this.agents.set(entry.tabId, { session, page: session, ref: left, release });
      return entry.tabId;
    } catch (error) {
      release();
      this.held.delete(refKey(left));
      throw error;
    }
  }
  private async openAgent(restoredId?: string): Promise<string> {
    const id = restoredId ?? `agent-${++this.sequence}`;
    const release = this.reserve();
    let session: UserTabSession & { ref: UserTabRef };
    try {
      session = await this.user.open(this.tabRequest(id));
    } catch (error) {
      release();
      throw error;
    }
    if (this.closed) {
      release();
      await session.close();
      throw new Error("Browser closed");
    }
    this.agents.set(id, { session, page: session, ref: session.ref, release });
    this.held.add(refKey(session.ref));
    return id;
  }
  /** An agent tab leaves the thread; its budget place goes with it. */
  private dropAgent(id: string): Entry | undefined {
    const entry = this.agents.get(id);
    this.agents.delete(id);
    entry?.release?.();
    if (entry?.ref) this.held.delete(refKey(entry.ref));
    return entry;
  }
  /**
   * A page in one of this thread's agent tabs opened a tab (`target=_blank`, `window.open`):
   * the extension made it an agent tab, and the thread takes it as its own, as ace's own
   * browsers do, instead of leaving it out of reach in the person's browser.
   */
  private adoptPopups(): void {
    const owned = new Map<string, string>();
    for (const [id, entry] of this.agents) if (entry.ref) owned.set(refKey(entry.ref), id);
    for (const popup of this.user.popups()) {
      const key = refKey(popup);
      const opener = owned.get(
        refKey({ connectionId: popup.connectionId, tabId: popup.openerTabId }),
      );
      if (!opener || owned.has(key) || this.adopting.has(key) || this.refused.has(key)) continue;
      this.adopting.add(key);
      void this.adoptPopup(popup, opener).finally(() => this.adopting.delete(key));
    }
  }
  private async adoptPopup(ref: UserTabRef, opener: string): Promise<void> {
    const id = `agent-${++this.sequence}`;
    let release: () => void;
    try {
      release = this.reserve();
    } catch {
      // The daemon-wide budget is full: the popup stays the person's browser's own business.
      this.refused.add(refKey(ref));
      return;
    }
    let session: UserTabSession;
    try {
      session = await this.user.adopt(this.tabRequest(id), ref);
    } catch {
      release();
      this.refused.add(refKey(ref));
      return;
    }
    // Over the thread's tab limit, or after the thread's browser closed: the popup goes.
    if (this.closed || this.agents.size + this.claimed.size >= (this.request.maxTabs ?? 16)) {
      release();
      this.refused.add(refKey(ref));
      await session.close();
      return;
    }
    this.agents.set(id, { session, page: session, ref, opener, release });
    this.held.add(refKey(ref));
    this.request.changed?.();
  }
  /**
   * A tab went away in the person's browser (closed, un-shared, Stop, a lost link). The thread
   * keeps its other tabs; with no agent tab left, the whole session is lost and closes. It is
   * never moved to another browser: the person's logins would not come with it.
   */
  private tabLost(id: string, reason: string): void {
    if (this.closed) return;
    // The whole browser went away: the session is lost with every agent tab still listed, so
    // they are all kept for when it comes back, rather than dropped one by one.
    const ref = this.agents.get(id)?.ref;
    if (ref && !this.user.connected(ref.connectionId)) {
      this.request.lost(reason);
      return;
    }
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
    this.dropAgent(id);
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
        title: entry.session?.title() ?? "",
        pending_dialog: this.dialogOf(tabId, entry),
      })),
      ...this.shared().map((ref) => {
        const tabId = sharedId(ref);
        const entry = this.claimed.get(tabId);
        return {
          tabId,
          url: ref.tab.url,
          title: ref.tab.title,
          openedBy: { kind: "human" as const },
          pending_dialog: entry && this.dialogOf(tabId, entry),
        };
      }),
    ];
  }
  /** The tab's pending dialog, as the thread names it. */
  private dialogOf(tabId: string, entry: Entry): BrowserDialog | undefined {
    const dialog = entry.session?.dialog();
    if (!dialog) return undefined;
    const { serial, ...rest } = dialog;
    return { dialogId: `${tabId}-dialog-${serial}`, tabId, ...rest };
  }
  private entries(): [string, Entry][] {
    return [...this.agents, ...this.claimed];
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
    const attach = (): Promise<UserTabSession> => {
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
      frames: async () => (await attach()).frames?.() ?? [],
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
          this.dropAgent(id);
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
      dialog: () => {
        for (const [id, entry] of this.entries()) {
          const pending = this.dialogOf(id, entry);
          if (pending) return pending;
        }
        return undefined;
      },
      answer: async (dialogId, accept, promptText) => {
        const found = this.entries().find(
          ([id, entry]) => this.dialogOf(id, entry)?.dialogId === dialogId,
        );
        if (!found?.[1].session) throw new Error("Dialog no longer pending");
        await found[1].session.answerDialog(accept, promptText);
      },
      // No `downloads`: the person's browser saves what its tabs download itself.
      opener: (id) => this.agents.get(id)?.opener,
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
      frames: async () => (await current().frames?.()) ?? [],
      close: () => this.close(),
    };
  }
  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    const entries = [...this.agents.values(), ...this.claimed.values()];
    for (const entry of this.agents.values()) {
      entry.release?.();
      if (entry.ref) this.held.delete(refKey(entry.ref));
    }
    this.agents.clear();
    this.claimed.clear();
    await Promise.allSettled(entries.map((entry) => entry.session?.close()));
  }
}
