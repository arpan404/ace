import type { BrowserTab, BrowserTabActor } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import { AgentCursors } from "./agent-cursors.ts";
import type { BrowserBackendPage, BrowserBackendSession } from "./backend.ts";
import type { Actor } from "./session-options.ts";
import { TabRuntime, type TabHost, type TabMeta } from "./tab-runtime.ts";
import { tabOpenRefusal } from "./tab-limits.ts";
import type { BrowserTabRecord } from "./tab-store.ts";

/** The one page of a backend that reports no tabs. */
const soleTab = "page";

export function tabActor(actor: Actor): BrowserTabActor {
  return actor.kind === "agent"
    ? { kind: "agent", ...(actor.agentId ? { agentId: actor.agentId } : {}) }
    : { kind: "human" };
}

/**
 * The ordered tabs of one thread's browser and who uses which. It mirrors the backend's tab list,
 * routes each command to a tab, and serializes only structural changes (open, close, select).
 */
export class SessionTabs {
  private runtimes = new Map<string, TabRuntime>();
  readonly cursors = new AgentCursors();
  /** When the person last picked the tab they view; agent tabs leave the view alone a while. */
  private pickedAt = -Infinity;
  private lock: Promise<unknown> = Promise.resolve();
  private host: TabHost;
  private backend: () => BrowserBackendSession;
  /** Metadata for tabs the backend has not reported yet (restored or being opened). */
  private pending = new Map<string, TabMeta>();
  /** The opener of the tab being opened right now; backends report the tab before returning. */
  private opening: TabMeta | undefined;
  constructor(host: TabHost, backend: () => BrowserBackendSession) {
    this.host = host;
    this.backend = backend;
  }
  /** Each tab's own page; a backend without per-tab pages has one usable page, its active tab. */
  page(tabId: string): BrowserBackendPage {
    const backend = this.backend();
    const tabs = backend.tabs;
    if (!tabs) return backend;
    if (tabs.page) return tabs.page(tabId);
    if (tabId === tabs.active()) return backend;
    throw new BrowserActionError("not_supported");
  }
  all(): TabRuntime[] {
    return [...this.runtimes.values()];
  }
  viewedId(): string {
    return this.backend().tabs?.active() ?? soleTab;
  }
  viewed(): TabRuntime | undefined {
    return this.runtimes.get(this.viewedId());
  }
  find(tabId: string): TabRuntime | undefined {
    if (!this.backend().tabs) return this.runtimes.get(soleTab);
    return this.runtimes.get(tabId);
  }
  get(tabId: string): TabRuntime {
    const runtime = this.find(tabId);
    if (!runtime) throw new BrowserActionError("tab_not_found");
    return runtime;
  }
  /** Prepare metadata for a tab the backend is about to report. */
  expect(tabId: string, meta: TabMeta): void {
    this.pending.set(tabId, meta);
  }
  /**
   * Mirror the backend's tab list. New tabs get a runtime (the first one may carry the viewed
   * tab's privacy forward from a replaced backend); vanished tabs are closed and lose cursors.
   */
  reconcile(carried?: { private: boolean }): { added: TabRuntime[]; removed: TabRuntime[] } {
    const tabs = this.backend().tabs;
    const listed = tabs ? tabs.list() : [];
    const ids = tabs ? listed.map((tab) => tab.tabId) : [soleTab];
    const added: TabRuntime[] = [],
      removed: TabRuntime[] = [];
    for (const [id, runtime] of this.runtimes)
      if (!ids.includes(id)) {
        this.runtimes.delete(id);
        this.cursors.forget(id);
        removed.push(runtime);
      }
    let carry = carried;
    const ordered = new Map<string, TabRuntime>();
    for (const id of ids) {
      let runtime = this.runtimes.get(id);
      if (!runtime) {
        // A backend may say who opened a tab (the person's own shared tabs, ADR 0084).
        const reported = listed.find((tab) => tab.tabId === id)?.openedBy;
        const meta = this.pending.get(id) ??
          (reported ? { openedBy: reported } : undefined) ??
          this.opening ?? { openedBy: { kind: "page" as const } };
        if (!this.pending.delete(id) && !reported) this.opening = undefined;
        runtime = new TabRuntime(this.host, id, carry?.private ? { ...meta, private: true } : meta);
        carry = undefined;
        added.push(runtime);
      }
      ordered.set(id, runtime);
    }
    this.runtimes = ordered;
    return { added, removed };
  }
  /** The tab a command runs on: its explicit tab, the agent's own tab, else the viewed one. */
  resolve(actor: Actor, tabId?: string): TabRuntime {
    if (tabId !== undefined) return this.get(tabId);
    if (actor.kind === "agent") {
      const cursor = this.cursors.get(actor.agentId);
      const own = cursor === undefined ? undefined : this.find(cursor);
      if (own) return own;
    }
    const viewed = this.viewed() ?? this.all()[0];
    if (!viewed) throw new BrowserActionError("browser_closed");
    if (actor.kind === "agent") this.cursors.set(actor.agentId, viewed.id);
    return viewed;
  }
  /** Whether an agent without its own tab would land on a tab another agent is using. */
  contended(actor: Actor): boolean {
    // Callers without an agent id share the viewed tab as before tabs existed.
    if (actor.kind !== "agent" || actor.agentId === undefined) return false;
    const cursor = this.cursors.get(actor.agentId);
    if (cursor !== undefined && this.find(cursor)) return false;
    return this.cursors.heldByOther(actor.agentId, this.viewedId());
  }
  /** Tabs as clients and agents read them; `current` marks the calling agent's own tab. */
  list(actor?: Actor): (BrowserTab & { current?: boolean })[] {
    const tabs = this.backend().tabs;
    if (!tabs) return [];
    const cursor = actor?.kind === "agent" ? this.cursors.get(actor.agentId) : undefined;
    return tabs.list().map((tab) => {
      const runtime = this.runtimes.get(tab.tabId);
      if (!runtime) return tab;
      const entry: BrowserTab & { current?: boolean } = Object.assign({}, tab, {
        lifecycle: runtime.crashed() ? "crashed" : runtime.lifecycle,
      });
      if (runtime.private) entry.private = true;
      const inUse = runtime.inUse();
      if (inUse) entry.inUse = inUse;
      const pointer = runtime.pointer();
      if (pointer) entry.pointer = pointer;
      if (runtime.openedBy) entry.openedBy = runtime.openedBy;
      if (runtime.drivenBy) entry.drivenBy = runtime.drivenBy;
      if (runtime.label) entry.label = runtime.label;
      const status = this.statusOf(tab.tabId);
      if (status) entry.loading = status.loading;
      if (cursor === tab.tabId) entry.current = true;
      return entry;
    });
  }
  private statusOf(tabId: string) {
    try {
      return this.page(tabId).pageStatus?.();
    } catch {
      return undefined;
    }
  }
  records(): BrowserTabRecord[] {
    const tabs = this.backend().tabs;
    if (!tabs) return [];
    return tabs.list().flatMap((tab, position) => {
      const runtime = this.runtimes.get(tab.tabId);
      return runtime
        ? [
            {
              tabId: tab.tabId,
              position,
              url: tab.url,
              title: tab.title,
              ...(runtime.label ? { label: runtime.label } : {}),
              ...(runtime.openedBy ? { openedBy: runtime.openedBy } : {}),
              ...(runtime.private ? { private: true } : {}),
              lastActiveAt: runtime.lastActiveAt,
            },
          ]
        : [];
    });
  }
  /** Open, close and select change the tab set one at a time; page commands never wait here. */
  structural<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work);
    this.lock = result.catch(() => {});
    return result;
  }
  /**
   * Opens a tab for `actor`. The person's view moves to it when they opened it, or when an
   * agent opened it and the person has not picked or used a tab lately.
   */
  async open(actor: Actor, options: { label?: string | undefined }): Promise<TabRuntime> {
    const tabs = this.backend().tabs;
    if (!tabs) throw new BrowserActionError("not_supported");
    const opener = tabActor(actor);
    const refusal = tabOpenRefusal(this.all(), opener);
    if (refusal) throw new BrowserActionError("tab_limit");
    const follow = actor.kind === "human" || this.follows();
    const before = new Set(tabs.list().map((tab) => tab.tabId));
    const meta: TabMeta = { openedBy: opener, ...(options.label ? { label: options.label } : {}) };
    let id: string;
    this.opening = meta;
    try {
      id = await tabs.open({ background: !follow });
    } catch (error) {
      if (error instanceof Error && /tab limit/i.test(error.message))
        throw new BrowserActionError("tab_limit");
      throw error;
    } finally {
      this.opening = undefined;
    }
    // A backend that holds one tab hands back the one it has: the opener reuses that page.
    if (before.has(id)) {
      if (actor.kind === "agent") this.cursors.set(actor.agentId, id);
      return this.get(id);
    }
    if (!this.runtimes.has(id)) this.expect(id, meta);
    this.reconcile();
    const runtime = this.get(id);
    runtime.openedBy = opener;
    if (options.label) runtime.label = options.label;
    if (actor.kind === "agent") this.cursors.set(actor.agentId, id);
    if (follow && tabs.active() !== id) await tabs.switch(id);
    if (actor.kind === "human") this.picked();
    return runtime;
  }
  async select(actor: Actor, tabId: string): Promise<TabRuntime> {
    const runtime = this.get(tabId);
    const tabs = this.backend().tabs;
    if (actor.kind === "agent") {
      this.cursors.set(actor.agentId, tabId);
      if (!this.follows() || !tabs) return runtime;
    } else this.picked();
    if (tabs && tabs.active() !== tabId) await tabs.switch(tabId);
    return runtime;
  }
  /** Whether this is the browser's only tab. */
  last(tabId: string): boolean {
    const tabs = this.backend().tabs;
    return !tabs || tabs.list().every((tab) => tab.tabId === tabId);
  }
  async close(tabId: string): Promise<void> {
    const tabs = this.backend().tabs;
    if (!tabs) throw new BrowserActionError("not_supported");
    const runtime = this.get(tabId);
    if (tabs.list().length <= 1)
      throw new BrowserActionError("not_supported", "Close the browser to close its last tab");
    await tabs.close(tabId);
    this.reconcile();
    void runtime.close();
  }
  private picked(): void {
    this.pickedAt = this.host.options.navigationClock.now();
  }
  /**
   * Agent tabs take the view only while the person has neither picked a tab nor used the one
   * they view within `followAfterMs`: an agent never pulls the page out from under them.
   */
  private follows(): boolean {
    const window = this.host.timing.followAfterMs;
    if (this.host.options.navigationClock.now() - this.pickedAt < window) return false;
    return !this.viewed()?.humanWithin(window);
  }
  clear(): void {
    this.runtimes.clear();
    this.cursors.clear();
    this.pending.clear();
  }
}
