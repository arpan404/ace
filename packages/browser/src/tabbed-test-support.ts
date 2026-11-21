import { FakeHeadless } from "./backend-test-support.ts";
import type { BackendOpen, BrowserBackendSession } from "./backend.ts";

/**
 * ace's Chrome, faked with tabs: a thread's browser opens one blank tab, or the tabs it is asked
 * to restore with their ids, as ace's Chrome does after a restart. Every address a page is asked
 * to load is written down in `loads`, restores included, so a test can tell a page loaded once
 * from one loaded twice. `failOpen` makes the next open fail.
 */
export class TabbedHeadless extends FakeHeadless {
  readonly loads: string[] = [];
  #failing: string | undefined;
  #ids = 0;
  failOpen(reason: string): void {
    this.#failing = reason;
  }
  override async open(request: BackendOpen): Promise<BrowserBackendSession> {
    const failing = this.#failing;
    this.#failing = undefined;
    if (failing) throw new Error(failing);
    const tabs = new Map<string, BrowserBackendSession>();
    const add = async (tabId: string, url: string) => {
      const page = await super.open(request);
      const fake = this.pages.at(-1);
      if (fake) fake.url = url;
      if (url !== "about:blank") this.loads.push(url);
      tabs.set(tabId, {
        ...page,
        navigate: async (address: string, timeout: number, signal?: AbortSignal) => {
          this.loads.push(address);
          await page.navigate(address, timeout, signal);
          request.changed?.();
        },
      });
      return tabId;
    };
    const restoring = request.restoreTabs ?? [];
    if (restoring.length) for (const tab of restoring) await add(tab.tabId, tab.url);
    else await add(`tab-${++this.#ids}`, "about:blank");
    let active = [...tabs.keys()][0] ?? "";
    const page = (tabId: string) => {
      const found = tabs.get(tabId);
      if (!found) throw new Error("No such tab");
      return found;
    };
    const first = page(active);
    return {
      ...first,
      url: () => page(active).url(),
      navigate: (address, timeout, signal) => page(active).navigate(address, timeout, signal),
      tabs: {
        list: () =>
          [...tabs.entries()].map(([tabId, tab]) => ({ tabId, url: tab.url(), title: "" })),
        active: () => active,
        open: async (options) => {
          const tabId = await add(`tab-${++this.#ids}`, "about:blank");
          if (!options?.background) active = tabId;
          request.changed?.();
          return tabId;
        },
        switch: async (tabId) => {
          page(tabId);
          active = tabId;
          request.changed?.();
        },
        close: async (tabId) => {
          tabs.delete(tabId);
          if (active === tabId) active = [...tabs.keys()][0] ?? "";
          request.changed?.();
        },
        dialog: () => undefined,
        answer: async () => {},
        page,
      },
    };
  }
}
