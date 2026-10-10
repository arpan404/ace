import { z } from "zod";
import { pageStatus } from "./page-status.ts";
import type { BrowserContext, Page, CDPSession, Dialog } from "playwright-core";
import { BrowserDialog, type BrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { HeadlessDownloads } from "./headless-downloads.ts";
import { BrowserInspection } from "./inspection.ts";
import { sizeHeadlessContents } from "./headless-size.ts";
import { pageFrames } from "./page-frames.ts";

type Guard = Awaited<ReturnType<typeof installOriginGuard>>;
interface Tab {
  title: string;
  id: string;
  page: Page;
  cdp: CDPSession;
  guard: Guard;
  release(): void;
  status: ReturnType<typeof pageStatus>;
  dialog?: { state: BrowserDialog; native: Dialog } | undefined;
}
/** One main page, plus a temporary human auth popup in the same profile. */
export class HeadlessTabs {
  private tabs = new Map<string, Tab>();
  private starting = new Map<Page, Promise<Tab>>();
  private sequence = 0;
  private activeId = "";
  private popupKinds = new Map<Page, boolean[]>();
  private controller: "agent" | "human" | "none" = "agent";
  private stopped = false;
  readonly downloads: HeadlessDownloads;
  readonly inspection: BrowserInspection;
  private request: BackendOpen;
  private context: BrowserContext;
  constructor(context: BrowserContext, request: BackendOpen) {
    this.context = context;
    this.request = request;
    this.downloads = new HeadlessDownloads(request);
    this.inspection = new BrowserInspection(request.log);
  }
  current(): Tab {
    const tab = this.tabs.get(this.activeId);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }
  active(): string {
    return this.activeId;
  }
  list(): BrowserTab[] {
    return [...this.tabs.values()].map((entry) => ({
      tabId: entry.id,
      url: entry.page.url().slice(0, 8192),
      title: entry.title,
      pending_dialog: entry.dialog?.state,
    }));
  }
  private async attach(page: Page): Promise<Tab> {
    if (this.stopped || this.tabs.size + this.starting.size >= 2)
      throw new Error("Browser tab limit");
    const release = this.request.reserveTab?.() ?? (() => {});
    const id = `tab-${this.request.id?.() ?? ++this.sequence}`;
    // Register dialog/download listeners before the first CDP await.
    let dialog: Tab["dialog"];
    page.on("dialog", (native) => {
      if (native.type() === "beforeunload" && this.controller === "agent") {
        void native.accept().catch(() => {});
        return;
      }
      dialog = {
        native,
        state: BrowserDialog.parse({
          dialogId: `${id}-dialog-${this.request.id?.() ?? ++this.sequence}`,
          tabId: id,
          type: native.type(),
          message: native.message().slice(0, 4096),
          defaultPrompt: native.defaultValue().slice(0, 4096),
        }),
      };
      const tab = this.tabs.get(id);
      if (tab) tab.dialog = dialog;
      this.request.changed?.();
    });
    page.on("download", (download) => {
      void this.downloads.accept(download, id);
    });
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send("Page.enable");
      cdp.on("Page.windowOpen", (raw: unknown) => {
        const popup = z
          .object({
            url: z.string().max(8192),
            windowName: z.string().optional(),
            windowFeatures: z.array(z.string()).optional(),
          })
          .safeParse(raw);
        if (!popup.success) return;
        const reuse =
          this.controller === "agent" ||
          ((!popup.data.windowName || popup.data.windowName.startsWith("_")) &&
            !popup.data.windowFeatures?.length);
        const kinds = this.popupKinds.get(page) ?? [];
        if (kinds.length < 8) kinds.push(reuse);
        this.popupKinds.set(page, kinds);
        if (reuse)
          void this.request
            .allowed(popup.data.url, { navigation: true, human: this.controller === "human" })
            .then((allowed) =>
              allowed ? page.goto(popup.data.url, { waitUntil: "domcontentloaded" }) : undefined,
            )
            .catch(() => {});
      });
      const viewport = page.viewportSize();
      if (viewport) await sizeHeadlessContents(cdp, viewport.width, viewport.height);
      const guard = await installOriginGuard(cdp, this.request.allowed, this.request.initiator, {
        attach: (child) => this.inspection.attach(child, id),
        detach: (child) => this.inspection.detach(child),
      });
      const tab: Tab = {
        status: pageStatus(cdp, () => this.request.changed?.()),
        title: "",
        id,
        page,
        cdp,
        guard,
        release,
        ...(dialog ? { dialog } : {}),
      };
      if (this.stopped) {
        guard.close();
        throw new Error("Browser closed");
      }
      this.tabs.set(id, tab);
      if (!this.activeId || (await page.opener())) this.activeId = id;
      page.once("close", () => {
        this.tabs.delete(id);
        this.popupKinds.delete(page);
        guard.close();
        this.inspection.detach(cdp);
        tab.status.close();
        release();
        if (this.activeId === id) {
          this.activeId = this.tabs.keys().next().value ?? "";
          if (!this.stopped) this.request.navigation();
        }
        if (!this.stopped && this.tabs.size === 0) this.request.lost("All browser tabs closed");
        if (!this.stopped) this.request.changed?.();
      });
      page.on("framenavigated", () => {
        if (this.activeId === id) this.request.navigation();
        this.request.changed?.();
      });
      page.on("console", (message) =>
        this.request.log({ kind: "console", type: message.type(), text: message.text() }),
      );
      page.on("pageerror", (error) =>
        this.request.log({ kind: "console", type: "pageerror", text: error.message }),
      );
      page.on("domcontentloaded", () => {
        void page
          .title()
          .then((title) => {
            tab.title = title.slice(0, 1024);
            this.request.changed?.();
          })
          .catch(() => {});
      });
      await this.inspection.attach(cdp, id);
      await this.downloads.progress(cdp);
      this.request.changed?.();
      return tab;
    } catch (error) {
      release();
      await page.close().catch(() => {});
      throw error;
    }
  }
  private enroll(page: Page): Promise<Tab> {
    const existing = this.starting.get(page);
    if (existing) return existing;
    const tab = [...this.tabs.values()].find((entry) => entry.page === page);
    if (tab) return Promise.resolve(tab);
    const task = this.attach(page);
    this.starting.set(page, task);
    void task.finally(() => this.starting.delete(page)).catch(() => {});
    return task;
  }
  async start(): Promise<void> {
    // Routing covers the first popup request before its CDP session is attached.
    await this.context.route("**/*", async (route) => {
      try {
        const req = route.request();
        let page: Page;
        try {
          page = req.frame().page();
        } catch {
          // Chromium's first popup request can precede its Frame. Guard it before
          // continuing; agents' popup URLs already navigate the main page.
          const reusing = [...this.popupKinds.values()].some((kinds) => kinds[0] === true);
          if (
            this.controller !== "human" ||
            reusing ||
            this.tabs.size + this.starting.size >= 2 ||
            !(await this.request.allowed(req.url(), { navigation: true, human: true }))
          )
            await route.abort();
          else await route.continue();
          return;
        }
        const opener = await page.opener();
        if (opener && (this.controller === "agent" || this.popupKinds.get(opener)?.[0] === true)) {
          await route.abort();
          return;
        }
        const tab = await this.enroll(page);
        if (this.stopped || !this.tabs.has(tab.id)) {
          await route.abort();
          return;
        }
        if (
          await this.request.allowed(req.url(), {
            navigation: req.isNavigationRequest() && req.frame() === page.mainFrame(),
            human: this.request.initiator?.() ?? false,
          })
        )
          await route.continue();
        else await route.abort("blockedbyclient");
      } catch {
        await route.abort().catch(() => {});
      }
    });
    this.context.on("page", (page) => {
      void page
        .opener()
        .then(async (opener) => {
          const reuse = opener ? this.popupKinds.get(opener)?.shift() : undefined;
          if (opener && (reuse || this.controller === "agent")) return page.close();
          await this.enroll(page);
        })
        .catch(() => page.close().catch(() => {}));
    });
    this.context.on("response", (response) => {
      this.downloads.response(
        response.url(),
        response.headers()["content-type"] ?? "application/octet-stream",
      );
    });
    for (const page of this.context.pages()) await this.enroll(page);
    if (!this.tabs.size) await this.open();
  }
  async open(): Promise<string> {
    if (this.activeId) return this.activeId;
    return (await this.enroll(await this.context.newPage())).id;
  }
  async switch(id: string): Promise<void> {
    if (!this.tabs.has(id)) throw new Error("Browser tab unavailable");
    this.activeId = id;
    this.request.navigation();
    this.request.changed?.();
  }
  async close(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    if (this.tabs.size === 1) throw new Error("Close the browser to close its last tab");
    await tab.page.close({ runBeforeUnload: false });
  }
  dialog(): BrowserDialog | undefined {
    for (const tab of this.tabs.values()) if (tab.dialog) return tab.dialog.state;
    return undefined;
  }
  async answer(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    const tab = [...this.tabs.values()].find(
        (candidate) => candidate.dialog?.state.dialogId === dialogId,
      ),
      dialog = tab?.dialog;
    if (!tab || !dialog || dialog.state.dialogId !== dialogId)
      throw new Error("Dialog no longer pending");
    if (accept) await dialog.native.accept(promptText);
    else await dialog.native.dismiss();
    tab.dialog = undefined;
    this.request.changed?.();
  }
  lease(controller: "agent" | "human" | "none"): void {
    this.controller = controller;
  }
  async frames(): Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> {
    const tab = this.current();
    await tab.guard.ready();
    return pageFrames([tab.cdp, ...tab.guard.frameSessions()]);
  }

  stop(): void {
    this.stopped = true;
    this.inspection.clear();
    for (const tab of this.tabs.values()) {
      tab.guard.close();
      tab.release();
    }
  }
}
