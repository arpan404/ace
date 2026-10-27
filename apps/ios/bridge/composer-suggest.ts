import type { ClientCore } from "@ace/client";
import { BrowserTabList, ProviderKind, ThreadId, type CatalogEntry } from "@ace/protocol";
import {
  commandArguments,
  commandSuggestions,
  mentionSuggestions,
  type MentionTab,
  type MentionThread,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { CatalogReads, type Target } from "./composer-catalog.ts";
import { rowReference, suggestionRow, type RowSource } from "./composer-rows.ts";

/*
 * What the phone's composer suggests while typing `@` or a leading `/`, and what its + offers
 * (`composer-rows.ts` shapes each row). The rules are `@ace/ui-core`'s, shared with the web;
 * this shell reads the catalog, completes files and lists the thread's browser tabs and the
 * project's other threads. Swift sends each query as the person types; file reads wait for a
 * pause and only the newest query is answered, so typing never waits on the daemon.
 */

const id = z.string().min(1).max(128);
const Scope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), threadId: id }),
  /** New thread, before the thread exists: the project's draft scope and the chosen provider. */
  z.object({
    type: z.literal("draft"),
    workspaceId: id,
    provider: ProviderKind.optional().catch(undefined),
  }),
]);
type Scope = z.infer<typeof Scope>;
const count = z.number().int().nonnegative().max(1000);
export const SuggestAction = z.discriminatedUnion("kind", [
  /** The composer was focused: read the catalog before the person types `/`. */
  z.object({ kind: z.literal("prefetch"), scope: Scope }),
  z.object({
    kind: z.literal("query"),
    scope: Scope,
    list: z.enum(["mention", "command", "add"]),
    query: z.string().max(256),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** The references already in the message, for the per-message limits. */
    held: z.object({ all: count, threads: count, tabs: count }).optional().catch(undefined),
  }),
  z.object({ kind: z.literal("close") }),
  /** A prompt's arguments as typed in its form, for the row `row` of the last list. */
  z.object({
    kind: z.literal("arguments"),
    row: z.string().min(1).max(600),
    values: z.record(z.string().max(128), z.string().max(4096)),
  }),
  /** A file picked from `@`, offered first next time nothing is typed. */
  z.object({ kind: z.literal("remember"), scope: Scope, path: z.string().min(1).max(4096) }),
  /** A workflow from the + or `/` list, run now. */
  z.object({
    kind: z.literal("automation"),
    action: z.string().min(1).max(300),
    requestId: z.string().min(1).max(64),
  }),
]);
export type SuggestAction = z.infer<typeof SuggestAction>;

/** Builtin actions the phone runs: an open thread's, and New thread's (web's draft rules). */
const threadActions = new Set([
  "attach",
  "files",
  "plan",
  "goal",
  "model",
  "review",
  "automation.run",
]);
const draftActions = new Set(["attach", "files", "plan", "goal", "model", "project"]);

export interface SuggestPorts {
  owner: Pick<ClientCore, "request">;
  sink: PatchSink;
  preview: Preview;
  schedule(delay: number, run: () => void): () => void;
  now(): number;
  /** The thread open on the phone, while one is. */
  thread(): { threadId: string; workspaceId: string; provider: ProviderKind } | undefined;
  /** Every thread the inbox knows, for `@` a thread. */
  threads(): readonly MentionThread[];
  /** New thread's draft scope in a project, and its file completion. */
  draft: {
    draftScope(workspaceId: string): Promise<string>;
    complete(workspaceId: string, query: string, limit: number): Promise<string[]>;
  };
}

const pause = 120;
const fresh = 30_000;
const staleRetry = 1_500;
const staleRetries = 6;
const quiet = { timeoutMs: 15_000 };

export class ComposerSuggest {
  readonly #ports: SuggestPorts;
  readonly #catalogs: CatalogReads;
  readonly #recent = new Map<string, string[]>();
  #tabs: { threadId: string; at: number; tabs: MentionTab[] } | undefined;
  /** The newest query; anything older is never answered. */
  #seq = -1;
  #cancel: (() => void) | undefined;
  /** The rows of the newest list, by id, for a form's arguments. */
  #rows = new Map<string, RowSource>();

  constructor(ports: SuggestPorts) {
    this.#ports = ports;
    this.#catalogs = new CatalogReads(ports);
  }

  handle(raw: unknown): boolean {
    const parsed = SuggestAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    switch (action.kind) {
      case "prefetch": {
        const target = this.#target(action.scope);
        if (target) void this.#catalogs.read(target);
        break;
      }
      case "query":
        this.#query(action);
        break;
      case "close":
        this.#seq++;
        this.#cancel?.();
        this.#cancel = undefined;
        break;
      case "arguments":
        this.#arguments(action.row, action.values);
        break;
      case "remember": {
        const workspaceId =
          action.scope.type === "draft"
            ? action.scope.workspaceId
            : this.#target(action.scope)?.workspaceId;
        if (!workspaceId) break;
        const list = this.#recent.get(workspaceId) ?? [];
        this.#recent.set(
          workspaceId,
          [action.path, ...list.filter((path) => path !== action.path)].slice(0, 20),
        );
        break;
      }
      case "automation":
        void this.#automation(action.action, action.requestId);
        break;
    }
    return true;
  }

  /** The open thread's catalog as last read, for a `/name` typed without picking it. */
  entries(threadId: string): readonly CatalogEntry[] | undefined {
    return this.#catalogs.get(`thread:${threadId}`)?.entries;
  }

  /** New thread's catalog for a project and provider as last read. */
  draftEntries(workspaceId: string, provider: string): readonly CatalogEntry[] | undefined {
    return this.#catalogs.get(`draft:${workspaceId}:${provider}`)?.entries;
  }

  #target(scope: Scope): Target | undefined {
    if (scope.type === "draft")
      return scope.provider
        ? {
            ...scope,
            provider: scope.provider,
            key: `draft:${scope.workspaceId}:${scope.provider}`,
          }
        : undefined;
    const open = this.#ports.thread();
    return open && open.threadId === scope.threadId
      ? { ...open, type: "thread" as const, key: `thread:${open.threadId}` }
      : undefined;
  }

  #query(action: Extract<SuggestAction, { kind: "query" }>): void {
    const { seq, list, query } = action;
    // The + list is read ahead while typing goes on, so it never cancels the `@` or `/` list.
    const adding = list === "add";
    if (!adding) {
      this.#seq = seq;
      this.#cancel?.();
      this.#cancel = undefined;
    }
    const current = () => adding || seq === this.#seq;
    const scopeKey =
      action.scope.type === "thread"
        ? `thread:${action.scope.threadId}`
        : `draft:${action.scope.workspaceId}:${action.scope.provider ?? ""}`;
    const put = (state: string, sources: RowSource[] = []) => {
      if (!current()) return;
      if (!adding) this.#rows = new Map(sources.map((source) => [source.id, source]));
      const held = action.held ?? { all: 0, threads: 0, tabs: 0 };
      this.#ports.sink.put(adding ? "composer:add" : "composer:suggestions", () => ({
        type: adding ? "composer.add" : "composer.suggestions",
        scope: scopeKey,
        seq,
        list,
        query,
        state,
        rows: sources.map((source) => suggestionRow(source, held, this.#ports.preview)),
      }));
    };
    const scope = action.scope;
    if (list === "mention") {
      // A draft with no project chosen yet, or a closed thread, has nothing to complete.
      const workspaceId =
        scope.type === "draft" ? scope.workspaceId : this.#ports.thread()?.workspaceId;
      if (!workspaceId || (scope.type === "thread" && !this.#target(scope))) return put("empty");
      const wait = query ? pause : 0;
      this.#cancel = this.#ports.schedule(
        wait,
        () => void this.#mentions(scope, workspaceId, query, put),
      );
      return;
    }
    const target = this.#target(scope);
    // New thread with no agent chosen has no catalog; neither has a thread the phone left.
    if (!target) return put("empty");
    const show = () => {
      const catalog = this.#catalogs.get(target.key);
      if (!catalog || (catalog.reading && !catalog.entries.length && !catalog.failed))
        return put("loading");
      if (catalog.failed && !catalog.entries.length) return put("failed");
      const rows = commandSuggestions(catalog.entries, {
        query,
        provider: target.provider,
        draft: target.type === "draft",
        adding,
        actions: target.type === "draft" ? draftActions : threadActions,
      }).map((item) => Object.assign(item, { id: `entry:${item.entry?.id ?? item.label}` }));
      if (!rows.length && catalog.stale) return put("loading");
      put(rows.length ? "ready" : "empty", rows);
    };
    show();
    const catalog = this.#catalogs.get(target.key);
    if (!catalog || catalog.failed || catalog.stale || this.#ports.now() - catalog.at > fresh)
      void this.#catalogs.read(target).then(() => {
        if (!current()) return;
        show();
        const read = this.#catalogs.get(target.key);
        // Discovery still running: read again shortly while the list stays open.
        if (read?.stale && read.retries < staleRetries) {
          read.retries++;
          const again = this.#ports.schedule(staleRetry, () => {
            if (current()) this.#query(action);
          });
          if (!adding) this.#cancel = again;
        }
      });
  }

  async #mentions(
    scope: Scope,
    workspaceId: string,
    query: string,
    put: (state: string, sources?: RowSource[]) => void,
  ): Promise<void> {
    const seq = this.#seq;
    const recent = query ? [] : (this.#recent.get(workspaceId) ?? []);
    const threadId = scope.type === "thread" ? scope.threadId : undefined;
    const rows = (paths: readonly string[], tabs: readonly MentionTab[]) =>
      mentionSuggestions({
        query,
        recent,
        paths,
        tabs,
        threads: this.#ports.threads(),
        threadId,
        workspaceId,
      }).map((item) =>
        Object.assign(item, {
          id: item.path
            ? `file:${item.path}`
            : item.tab
              ? `tab:${item.tab.tabId}`
              : `thread:${item.threadId ?? item.label}`,
        }),
      );
    // Recent files and matching threads show at once; completed files join them.
    const early = rows([], []);
    put(early.length ? "ready" : "loading", early);
    const [paths, tabs] = await Promise.all([
      this.#complete(scope, workspaceId, query).catch(() => undefined),
      threadId ? this.#browserTabs(threadId) : Promise.resolve([]),
    ]);
    if (seq !== this.#seq) return;
    const all = rows(paths ?? [], tabs);
    if (all.length) put("ready", all);
    else put(paths ? "empty" : "failed");
  }

  async #complete(scope: Scope, workspaceId: string, query: string): Promise<string[]> {
    if (scope.type === "draft") return this.#ports.draft.complete(workspaceId, query, 8);
    const reply = await this.#ports.owner.request(
      {
        type: "context.request",
        operation: {
          op: "mention.complete",
          threadId: ThreadId.parse(scope.threadId),
          query: query.slice(0, 128),
          limit: 8,
        },
      },
      quiet,
    );
    if (reply.result.kind !== "completion") throw new Error(reply.result.kind);
    return reply.result.paths.slice(0, 8);
  }

  /** The thread's browser tabs agents may read, read again after two seconds. */
  async #browserTabs(threadId: string): Promise<MentionTab[]> {
    const kept = this.#tabs;
    if (kept?.threadId === threadId && this.#ports.now() - kept.at < 2_000) return kept.tabs;
    try {
      const reply = await this.#ports.owner.request(
        { type: "browser.tabs.list", threadId: ThreadId.parse(threadId) },
        quiet,
      );
      const listed = reply.ok ? BrowserTabList.safeParse(reply.result) : undefined;
      const tabs = (listed?.data ?? []).flatMap((tab) =>
        tab.private || !tab.url || tab.url === "about:blank"
          ? []
          : [{ tabId: tab.tabId, url: tab.url, title: tab.title }],
      );
      this.#tabs = { threadId, at: this.#ports.now(), tabs };
      return tabs;
    } catch {
      return [];
    }
  }

  #arguments(row: string, typed: Record<string, string>): void {
    const source = this.#rows.get(row);
    const put = (error: string | null, values?: Record<string, string | number | boolean>) =>
      this.#ports.sink.put("composer:arguments", () => ({
        type: "composer.arguments",
        row,
        error,
        reference: values && source ? rowReference(source, values) : null,
      }));
    if (!source?.entry) return put("This command has changed. Type / to choose it again.");
    const checked = commandArguments(source.entry, typed);
    if ("error" in checked) put(checked.error);
    else put(null, checked.values);
  }

  async #automation(action: string, requestId: string): Promise<void> {
    const admission = (ok: boolean, message: string) =>
      this.#ports.sink.put(`admission:${requestId}`, () => ({
        type: "admission",
        id: requestId,
        ok,
        message,
      }));
    const prefix = "automation.run:";
    if (!action.startsWith(prefix)) return admission(false, "That action isn't available here.");
    try {
      const reply = await this.#ports.owner.request(
        { type: "automation.run", id: action.slice(prefix.length), variables: {} },
        quiet,
      );
      admission(
        reply.ok,
        reply.ok ? "" : "Couldn't run this workflow. Try again from Automations.",
      );
    } catch {
      admission(false, "Couldn't run this workflow. Check the connection and try again.");
    }
  }
}

/** The threads the inbox knows, at most 2,000, for `@` a thread. */
export function sidebarThreads(owner: Pick<ClientCore, "threads">): MentionThread[] {
  const sidebar = owner.threads();
  try {
    return sidebar.store.ids.slice(0, 2_000).flatMap((threadId) => {
      const entry = sidebar.store.thread(threadId);
      return entry ? [{ id: entry.id, title: entry.title, workspaceId: entry.workspaceId }] : [];
    });
  } finally {
    sidebar.release();
  }
}
