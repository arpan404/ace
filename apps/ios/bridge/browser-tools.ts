import { BrowserFeaturesClient, type ClientCore } from "@ace/client";
import {
  BrowserState,
  BrowserTabsResult,
  WorkspaceId,
  type BrowserCommand,
  type ThreadId,
} from "@ace/protocol";
import {
  addressProblems,
  BrowsingHistory,
  describeBrowserFailure,
  parseAddress,
  searchVisits,
  zoomIn,
  zoomOut,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import type { Navigation } from "./browser-view.ts";
import { BrowserConsole, ConsoleFilter } from "./browser-console.ts";
import { BrowserChooser } from "./browser-chooser.ts";
import { Picked, type ChunkReader } from "./thread-attachments.ts";
import type { Schedule } from "./browser-live.ts";

/*
 * What the person does with the thread's browser from the phone, besides touching the page:
 * go to an address (opening the thread's browser first when it has none), open, close and keep
 * agents out of tabs, Back and Forward, find, zoom, the console, a screenshot, history, and the
 * answers a page waits for (a dialog, a sign-in, files, a certificate). Failures come back as
 * one sentence (`browser:problem`); a failed navigation shows in place of the page instead.
 */

const tabId = z.string().min(1).max(256);
export const BrowserToolAction = z.discriminatedUnion("kind", [
  /** Typed into the address bar: an address, or a reason it isn't one. */
  z.object({ kind: z.literal("go"), text: z.string().max(8192) }),
  z.object({ kind: z.literal("newTab"), text: z.string().max(8192).optional() }),
  z.object({
    kind: z.literal("history"),
    direction: z.enum(["back", "forward", "reload", "stop"]),
  }),
  z.object({ kind: z.literal("tab"), tabId }),
  z.object({ kind: z.literal("closeTab"), tabId }),
  /** Take over (keep agents out of the tab) or hand it back. */
  z.object({ kind: z.literal("private"), tabId, value: z.boolean() }),
  z.object({ kind: z.literal("find"), text: z.string().max(4096), forward: z.boolean() }),
  z.object({ kind: z.literal("zoom"), step: z.enum(["in", "out", "reset"]) }),
  z.object({ kind: z.literal("screenshot"), fullPage: z.boolean() }),
  /** The console sheet: open with a filter, Clear, or closed (`filter` absent). */
  z.object({ kind: z.literal("console"), filter: ConsoleFilter.optional(), clear: z.boolean() }),
  /** The history sheet: open (searched for `query`) or closed. */
  z.object({ kind: z.literal("visits"), open: z.boolean(), query: z.string().max(256).optional() }),
  z.object({ kind: z.literal("forget"), url: z.string().max(8192), at: z.number() }),
  z.object({
    kind: z.literal("dialog"),
    tabId,
    dialogId: tabId,
    accept: z.boolean(),
    text: z.string().max(4096).optional(),
  }),
  z.object({
    kind: z.literal("signIn"),
    tabId,
    authId: tabId,
    credentials: z
      .object({ username: z.string().max(4096), password: z.string().max(4096) })
      .optional(),
  }),
  z.object({ kind: z.literal("files"), tabId, chooserId: tabId, files: z.array(Picked).max(16) }),
  z.object({ kind: z.literal("certificate"), tabId, url: z.string().max(8192) }),
  z.object({ kind: z.literal("reopen") }),
]);
export type BrowserToolAction = z.infer<typeof BrowserToolAction>;

/** The view the tools act on: the thread shown and its browser as last reported. */
export interface ToolsHost {
  owner: Pick<ClientCore, "request">;
  sink: PatchSink;
  preview: Preview;
  schedule: Schedule;
  now(): number;
  read: ChunkReader;
  current(): { threadId: ThreadId; state: BrowserState | undefined } | undefined;
  workspaceId(threadId: string): string | undefined;
  /** The navigation phase changed: send the view again. */
  changed(): void;
  /** A browser was just opened for the thread: watch it now rather than at the next retry. */
  opened(): void;
}

/** Navigating waits up to the command's own timeout; the reply gets a little longer. */
const navigateMs = 30_000;
/** Opening the first browser on a machine downloads Chromium. */
const openMs = 10 * 60_000;

export class BrowserTools {
  #host: ToolsHost;
  #navigation: Navigation | undefined;
  #history = new BrowsingHistory(undefined);
  #visits: string | undefined;
  #query = "";
  #console: BrowserConsole;
  #chooser: BrowserChooser;
  #features: BrowserFeaturesClient;
  constructor(host: ToolsHost) {
    this.#host = host;
    this.#console = new BrowserConsole(host, (command) => this.#execute(command));
    this.#chooser = new BrowserChooser(host, (message) => this.#problem(message));
    this.#features = new BrowserFeaturesClient(host.owner);
  }
  get navigation(): Navigation | undefined {
    return this.#navigation;
  }
  /** The view closed or moved to another thread. */
  close(): void {
    this.#navigation = undefined;
    this.#visits = undefined;
    this.#console.close();
    this.#chooser.close();
    for (const key of ["browser:find", "browser:shot", "browser:logs", "browser:visits"])
      this.#host.sink.clear(key);
  }
  /** A new browser state: the shown page joins the thread's history; a navigation outlived ends. */
  observe(state: BrowserState): void {
    const current = this.#host.current();
    const shown = state.tabs?.find((tab) => tab.tabId === state.activeTabId);
    if (current && shown) {
      this.#history.record(
        current.threadId,
        { url: shown.url, title: shown.title },
        this.#host.now(),
      );
      if (this.#visits === current.threadId) this.#putVisits(current.threadId);
    }
    const navigation = this.#navigation;
    const tab = navigation && state.tabs?.find((each) => each.tabId === navigation.tabId);
    // The tab committed a page of its own since the failure: the live page shows again.
    if (navigation?.failure && (!tab || (tab.url !== navigation.from && !state.loadError)))
      this.#navigation = undefined;
  }
  handle(action: BrowserToolAction): void {
    const current = this.#host.current();
    if (!current) return;
    const { threadId } = current;
    const shownId = current.state?.closed ? undefined : current.state?.activeTabId;
    switch (action.kind) {
      case "go":
        this.#go(action.text);
        return;
      case "newTab":
        void this.#newTab(action.text);
        return;
      case "history":
        this.#step(action.direction, shownId);
        return;
      case "tab":
        if (action.tabId === shownId) return;
        this.#ask("Couldn't show the tab", this.#features.selectTab(threadId, action.tabId));
        return;
      case "closeTab":
        this.#ask("Couldn't close the tab", this.#features.closeTab(threadId, action.tabId));
        return;
      case "private":
        this.#ask(
          action.value ? "Couldn't take over the page" : "Couldn't hand the page back",
          this.#features.keepPrivate(threadId, action.tabId, action.value),
        );
        return;
      case "find":
        void this.#find(action.text, action.forward, shownId);
        return;
      case "zoom": {
        const zoom = current.state?.tabs?.find((tab) => tab.tabId === shownId)?.zoom ?? 1;
        const factor =
          action.step === "in" ? zoomIn(zoom) : action.step === "out" ? zoomOut(zoom) : 1;
        void this.#execute({
          action: "zoom",
          factor,
          ...(shownId ? { tabId: shownId } : {}),
        }).catch((error: unknown) => this.#problem(`Couldn't zoom the page. ${reason(error)}`));
        return;
      }
      case "screenshot":
        void this.#screenshot(action.fullPage, shownId);
        return;
      case "console":
        if (action.filter) this.#console.open(action.filter, action.clear, shownId);
        else this.#console.close();
        return;
      case "visits":
        this.#visits = action.open ? threadId : undefined;
        this.#query = action.query ?? "";
        if (action.open) this.#putVisits(threadId);
        else this.#host.sink.clear("browser:visits");
        return;
      case "forget": {
        const visit = this.#history
          .visits(threadId)
          .find((each) => each.url === action.url && each.at === action.at);
        if (visit) this.#history.remove(threadId, visit);
        this.#putVisits(threadId);
        return;
      }
      case "dialog":
        this.#ask(
          "Couldn't answer the page",
          this.#features.answerDialog(
            threadId,
            action.tabId,
            action.dialogId,
            action.accept,
            action.accept ? action.text : undefined,
          ),
        );
        return;
      case "signIn":
        this.#ask(
          "Couldn't send the sign-in",
          this.#features.answerAuth(threadId, action.tabId, action.authId, action.credentials),
        );
        return;
      case "files":
        this.#chooser.choose(threadId, action.tabId, action.chooserId, action.files);
        return;
      case "certificate":
        this.#ask(
          "Couldn't open the page",
          this.#features.proceedCertificate(threadId, action.tabId, action.url),
        );
        return;
      case "reopen":
        void this.#open(threadId).catch((error: unknown) =>
          this.#problem(`Couldn't reopen the browser. ${reason(error)}`),
        );
        return;
    }
  }

  #go(text: string): void {
    const parsed = parseAddress(text);
    if (!parsed.ok) {
      if (parsed.reason !== "empty") this.#problem(addressProblems[parsed.reason]);
      return;
    }
    const current = this.#host.current();
    const state = current?.state;
    const shownId =
      state && !state.closed && state.status !== "paused" ? state.activeTabId : undefined;
    if (shownId) void this.#navigate(shownId, parsed.url);
    else void this.#newTab(parsed.url);
  }
  /** A new tab, shown at once; a browser opened just for it puts the page in its blank tab. */
  async #newTab(text: string | undefined): Promise<void> {
    const current = this.#host.current();
    if (!current) return;
    const parsed = text ? parseAddress(text) : undefined;
    if (parsed && !parsed.ok) {
      if (parsed.reason !== "empty") this.#problem(addressProblems[parsed.reason]);
      return;
    }
    const url = parsed?.ok ? parsed.url : undefined;
    try {
      const state = current.state;
      if (!state || state.closed || state.status === "paused") {
        const tabs = await this.#open(current.threadId);
        const only = tabs.length === 1 ? tabs[0] : undefined;
        if (only && (only.url === "" || only.url === "about:blank")) {
          if (url) await this.#navigate(only.tabId, url);
          return;
        }
      }
      const reply = await this.#host.owner.request({
        type: "browser.tabs.open",
        threadId: current.threadId,
        ...(url ? { url } : {}),
      });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      const result = BrowserTabsResult.safeParse(reply.result);
      if (result.success && "pending_dialog" in result.data)
        this.#problem("A page is waiting for an answer.");
    } catch (error) {
      this.#problem(`Couldn't open a tab. ${reason(error)}`);
    }
  }
  /** Opens the thread's browser (or reopens one that lost its pages). */
  async #open(threadId: ThreadId): Promise<readonly { tabId: string; url: string }[]> {
    const workspaceId = WorkspaceId.safeParse(this.#host.workspaceId(threadId));
    if (!workspaceId.success) throw new Error("The thread's project isn't known yet.");
    const reply = await this.#host.owner.request(
      {
        type: "browser.open",
        options: { threadId, workspaceId: workspaceId.data, headed: false, background: false },
      },
      { timeoutMs: openMs },
    );
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    this.#host.opened();
    const state = BrowserState.safeParse(reply.result);
    return state.success ? (state.data.tabs ?? []) : [];
  }
  async #navigate(tab: string, url: string): Promise<void> {
    const current = this.#host.current();
    if (!current) return;
    const from = current.state?.tabs?.find((each) => each.tabId === tab)?.url;
    const navigation: Navigation = { tabId: tab, url, from };
    this.#navigation = navigation;
    this.#host.changed();
    try {
      await this.#execute(
        { action: "navigate", url, timeout: navigateMs, waitUntil: "domcontentloaded", tabId: tab },
        navigateMs + 5_000,
      );
      if (this.#navigation === navigation) this.#navigation = undefined;
    } catch (error) {
      if (this.#navigation !== navigation) return;
      this.#navigation = { ...navigation, failure: describeBrowserFailure(reason(error), url) };
    }
    this.#host.changed();
  }
  #step(direction: "back" | "forward" | "reload" | "stop", shownId: string | undefined): void {
    const navigation = this.#navigation;
    if (navigation?.failure && navigation.tabId === shownId) {
      // A failed address: Reload tries it again, Back returns to the page the tab still shows.
      if (direction === "reload") {
        void this.#navigate(navigation.tabId, navigation.url);
        return;
      }
      if (direction === "back" && navigation.from !== navigation.url) {
        this.#navigation = undefined;
        this.#host.changed();
        return;
      }
    }
    if (!shownId) return;
    void this.#execute({ action: "history", direction, tabId: shownId }).catch(() => {});
  }
  async #find(text: string, forward: boolean, shownId: string | undefined): Promise<void> {
    try {
      const raw = await this.#execute({
        action: "find_text",
        text,
        forward,
        ...(shownId ? { tabId: shownId } : {}),
      });
      const matches = z
        .object({ matches: z.number(), active: z.number().optional() })
        .safeParse(raw);
      const found = z.object({ found: z.boolean() }).safeParse(raw);
      const message = matches.success
        ? matches.data.active !== undefined && matches.data.matches > 0
          ? `${matches.data.active} of ${matches.data.matches}`
          : `${matches.data.matches} ${matches.data.matches === 1 ? "match" : "matches"}`
        : found.success
          ? found.data.found
            ? "Match found"
            : "No matches"
          : "";
      this.#host.sink.put("browser:find", () => ({ type: "browser.find", text, message }));
    } catch (error) {
      this.#host.sink.put("browser:find", () => ({
        type: "browser.find",
        text,
        message: reason(error),
      }));
    }
  }
  async #screenshot(fullPage: boolean, shownId: string | undefined): Promise<void> {
    const at = this.#host.now();
    try {
      const raw = await this.#execute(
        { action: "screenshot", fullPage, ...(shownId ? { tabId: shownId } : {}) },
        60_000,
      );
      const shot = z.object({ path: z.string().max(8192), data: z.string().optional() }).parse(raw);
      this.#host.sink.put("browser:shot", () => ({
        type: "browser.shot",
        at,
        data: shot.data ?? null,
        path: shot.path,
      }));
    } catch (error) {
      this.#problem(`Couldn't take a screenshot. ${reason(error)}`);
    }
  }
  #putVisits(threadId: string): void {
    const preview = this.#host.preview;
    const query = this.#query;
    this.#host.sink.put("browser:visits", () => {
      const all = this.#history.visits(threadId);
      return {
        type: "browser.visits",
        threadId,
        total: all.length,
        visits: searchVisits(all, query).map((visit) => ({
          url: visit.url,
          title: preview(visit.title, 256),
          at: visit.at,
        })),
      };
    });
  }
  /** A person's command to the shown thread's browser; rejects with the daemon's reason. */
  async #execute(command: BrowserCommand, timeoutMs?: number): Promise<unknown> {
    const current = this.#host.current();
    if (!current) throw new Error("The browser isn't open.");
    const reply = await this.#host.owner.request(
      { type: "browser.execute", threadId: current.threadId, command },
      timeoutMs ? { timeoutMs } : {},
    );
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  }
  /** A one-shot request; its failure becomes one sentence. */
  #ask(title: string, request: Promise<unknown>): void {
    request.catch((error: unknown) => this.#problem(`${title}. ${reason(error)}`));
  }
  #problem(message: string): void {
    const at = this.#host.now();
    const text = this.#host.preview(message, 512);
    this.#host.sink.put("browser:problem", () => ({ type: "browser.problem", at, message: text }));
  }
}

/** An error's message as a person reads it. */
export function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "offline") return "ace is offline.";
  return message;
}
