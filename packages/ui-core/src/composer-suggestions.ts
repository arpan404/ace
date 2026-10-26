import type { CatalogEntry, CatalogMention, ProviderKind } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { displayAddress } from "./browser-address.ts";
import type { ComposerToken } from "./composer-tokens.ts";
import { catalogDisplayName } from "./extension-names.ts";

/*
 * What the composer suggests while typing `@` or a leading `/`, and what the + offers: one set
 * of rules for every client, so the web and the phones list the same rows in the same groups
 * and picking one does the same thing. Pure: callers bring the catalog, the files the daemon
 * completed, the thread's browser tabs and the other threads.
 */

/** The `@file` or `/command` being typed at the caret, if any. */
export interface ComposerTrigger {
  kind: "mention" | "command";
  query: string;
  /** Index of the `@` or `/`. */
  start: number;
  /** Caret index; the token runs from `start` to here. */
  end: number;
}

/** The token at the caret: a word starting with `@` or `/` (and holding no second one). */
export function triggerAt(text: string, caret: number): ComposerTrigger | undefined {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
  const word = text.slice(start, caret);
  if (word.startsWith("@") && !word.slice(1).includes("@"))
    return { kind: "mention", query: word.slice(1), start, end: caret };
  if (word.startsWith("/") && !word.slice(1).includes("/"))
    return { kind: "command", query: word.slice(1), start, end: caret };
  return undefined;
}

/** Each catalog kind's group in the list. */
export const catalogGroups: Readonly<Record<CatalogEntry["kind"], string>> = {
  builtin: "Add",
  plugin: "Plugins",
  skill: "Skills",
  command: "Commands",
  agent: "Agents",
  workflow: "Workflows",
  "mcp-tool": "Tools",
};
const groupOrder = ["Add", "Plugins", "Skills", "Commands", "Agents", "Workflows", "Tools"];

/** The thread's stored files, offered beside the daemon's own entries once a thread exists. */
export const attachmentsEntry: CatalogEntry = {
  id: "ace:attachments",
  kind: "builtin",
  name: "Attachments",
  description: "Manage files stored for this thread",
  source: { provider: "ace", scope: "ace" },
  invocation: { type: "action", action: "attachments" },
};

/** A browser tab of the thread's, as a mention offers it. */
export interface MentionTab {
  tabId: string;
  url: string;
  title: string;
}
/** Another thread a message can point at. */
export interface MentionThread {
  id: string;
  title: string;
  workspaceId: string;
}

export interface ComposerSuggestion<Tab extends MentionTab = MentionTab> {
  group: string;
  /** What the row reads. */
  label: string;
  detail?: string | undefined;
  path?: string | undefined;
  threadId?: string | undefined;
  tab?: Tab | undefined;
  entry?: CatalogEntry | undefined;
}

export interface CommandScope {
  query: string;
  provider: ProviderKind | undefined;
  /** No thread yet (New thread): only the daemon's entries, nothing about stored files. */
  draft: boolean;
  /** The + list: only the builtin entries, under "Add". */
  adding: boolean;
  /**
   * The builtin actions this client can run (by `actionKind`); any other is left out rather
   * than shown broken. Omitted, every action is listed.
   */
  actions?: ReadonlySet<string> | undefined;
}

/**
 * The catalog as the `/` list (or the + list while `adding`) shows it: entries without a
 * description, unavailable ones and plan mode for any provider but Claude are left out; saved
 * prompts without a description read "Run saved prompt"; builtins join a typed `/` only once
 * something is typed. Names match first, else descriptions; grouped in a fixed order.
 */
export function commandSuggestions(
  entries: readonly CatalogEntry[],
  scope: CommandScope,
): ComposerSuggestion[] {
  const { query, provider, draft, adding } = scope;
  const q = query.toLowerCase();
  const all = draft ? entries : [...entries, attachmentsEntry];
  const described = all.map((entry) =>
    entry.kind === "command" && !entry.description.trim()
      ? Object.assign({}, entry, { description: "Run saved prompt" })
      : entry,
  );
  const available = described.filter(
    (entry) =>
      entry.description.trim() &&
      entry.invocation.type !== "unavailable" &&
      !(
        entry.invocation.type === "action" &&
        ((entry.invocation.action === "plan" && provider !== "claude") ||
          (scope.actions && !scope.actions.has(actionKind(entry.invocation.action))))
      ) &&
      (adding ? entry.kind === "builtin" : entry.kind !== "builtin" || !!query.trim()),
  );
  const named = available.filter(
    (entry) =>
      entry.name.toLowerCase().includes(q) || catalogDisplayName(entry).toLowerCase().includes(q),
  );
  return (named.length ? named : available.filter((e) => e.description.toLowerCase().includes(q)))
    .map((entry) => ({
      group: adding
        ? catalogGroups[entry.kind]
        : entry.kind === "builtin"
          ? "Commands"
          : catalogGroups[entry.kind],
      label: entry.kind === "builtin" ? entry.name : catalogDisplayName(entry),
      detail: entry.description,
      entry,
    }))
    .toSorted((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
}

/** `automation.run:checks` is the `automation.run` action; others are their own name. */
export function actionKind(action: string): string {
  const colon = action.indexOf(":");
  return colon < 0 ? action : action.slice(0, colon);
}

export interface MentionScope<Tab extends MentionTab> {
  query: string;
  /** Files mentioned lately, offered first while nothing is typed. */
  recent: readonly string[];
  /** Files the daemon completed for the query, best first. */
  paths: readonly string[];
  tabs: readonly Tab[];
  threads: readonly MentionThread[];
  /** The thread (or draft) being written in, and its project. */
  threadId: string | undefined;
  workspaceId: string;
}

/**
 * What `@` offers: files (recent ones first while nothing is typed), then the thread's browser
 * tabs and the project's other threads whose title or address holds the query, at most 8 each.
 */
export function mentionSuggestions<Tab extends MentionTab>(
  scope: MentionScope<Tab>,
): ComposerSuggestion<Tab>[] {
  const q = scope.query.toLowerCase();
  const lately = scope.query ? [] : scope.recent;
  const files = [...new Set([...lately, ...scope.paths])].map((path) => ({
    group: "Files",
    label: path.slice(path.lastIndexOf("/") + 1),
    detail: path.includes("/") ? path : undefined,
    path,
  }));
  const tabs = scope.tabs
    .filter((tab) => tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q))
    .slice(0, 8)
    .map((tab) => ({
      group: "Browser tabs",
      label: tab.title || displayAddress(tab.url),
      detail: displayAddress(tab.url),
      tab,
    }));
  const threads = scope.threads
    .filter(
      (thread) =>
        thread.id !== scope.threadId &&
        thread.workspaceId === scope.workspaceId &&
        thread.title.toLowerCase().includes(q),
    )
    .slice(0, 8)
    .map((thread) => ({ group: "Threads", label: thread.title, threadId: thread.id }));
  return [...files, ...tabs, ...threads];
}

/** How many references one message carries at most, in all and of each costly kind. */
export const referenceLimits = { all: 64, threads: 8, tabs: 4 } as const;
export const tooManyReferences =
  "This message has enough references. Remove one before adding another.";

/** What picking a suggestion does. */
export type SuggestionPick =
  | { kind: "refused"; notice: string }
  /** Open the thread's stored files. */
  | { kind: "attachments" }
  /** Run a builtin action (`attach`, `files`, `plan`, ...). */
  | { kind: "action"; action: string }
  /** A prompt with parameters: ask for them, then add the reference with its values. */
  | { kind: "arguments" }
  | { kind: "reference" };

/** How many references a message holds: in all, threads and browser tabs. */
export interface HeldReferences {
  all: number;
  threads: number;
  tabs: number;
}
export function heldReferences(
  tokens: readonly Pick<ComposerToken, "thread" | "browserTab">[],
): HeldReferences {
  return {
    all: tokens.length,
    threads: tokens.filter((token) => token.thread).length,
    tabs: tokens.filter((token) => token.browserTab).length,
  };
}

export function pickSuggestion(item: ComposerSuggestion, held: HeldReferences): SuggestionPick {
  if (
    held.all >= referenceLimits.all ||
    (item.threadId && held.threads >= referenceLimits.threads) ||
    (item.tab && held.tabs >= referenceLimits.tabs)
  )
    return { kind: "refused", notice: tooManyReferences };
  const invocation = item.entry?.invocation;
  if (invocation?.type === "unavailable")
    return {
      kind: "refused",
      notice: "This item isn't available for this provider. Choose another item.",
    };
  if (invocation?.type === "action")
    return invocation.action === "attachments"
      ? { kind: "attachments" }
      : { kind: "action", action: invocation.action };
  if (invocation?.type === "prompt" && Object.keys(invocation.parameters ?? {}).length)
    return { kind: "arguments" };
  return { kind: "reference" };
}

/**
 * The reference a picked suggestion leaves in the message: the words it shows (`@name` for a
 * file, the title for a thread, tab or catalog entry) and what it points at. Offsets start at
 * `start`.
 */
export function suggestionToken(
  item: ComposerSuggestion,
  start: number,
  values?: NonNullable<CatalogMention["values"]>,
): ComposerToken {
  const label = item.entry || item.threadId || item.tab ? item.label : `@${item.label}`;
  const entry = item.entry;
  const catalog: CatalogMention | undefined = entry
    ? {
        type: "mention",
        entryId: entry.id,
        name: entry.name,
        title: label,
        kind: entry.kind,
        ...(entry.icon ? { icon: entry.icon } : {}),
        arguments: "",
        ...(values ? { values } : {}),
      }
    : undefined;
  return {
    start,
    end: start + label.length,
    label,
    ...(catalog ? { catalog } : {}),
    ...(item.path ? { file: { path: item.path } } : {}),
    ...(item.threadId
      ? {
          thread: {
            type: "thread_ref" as const,
            threadId: ThreadId.parse(item.threadId),
            budgetBytes: 4096,
          },
        }
      : {}),
    ...(item.tab
      ? {
          browserTab: {
            type: "browser_tab" as const,
            tabId: item.tab.tabId,
            url: item.tab.url,
            title: item.tab.title,
          },
        }
      : {}),
  };
}

/**
 * A prompt's arguments as typed (each a string; booleans "true"/"false", "" for the default),
 * checked against its parameters: the values to send, or what to fix first.
 */
export function commandArguments(
  entry: CatalogEntry,
  typed: Readonly<Record<string, string>>,
): { values: NonNullable<CatalogMention["values"]> } | { error: string } {
  const parameters = entry.invocation.type === "prompt" ? (entry.invocation.parameters ?? {}) : {};
  const values: NonNullable<CatalogMention["values"]> = {};
  for (const [name, parameter] of Object.entries(parameters)) {
    const value = typed[name] ?? "";
    if (!value && parameter.required) return { error: `Enter ${name} to continue.` };
    if (!value) continue;
    if (parameter.type === "number" && !Number.isFinite(Number(value)))
      return { error: `Enter a number for ${name}.` };
    values[name] =
      parameter.type === "number"
        ? Number(value)
        : parameter.type === "boolean"
          ? value === "true"
          : value;
  }
  return { values };
}
