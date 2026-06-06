import type { ProviderIntegrationCapabilities, ProviderKind } from "@ace/contracts";
import { isProviderSideConversationType } from "@ace/shared/providerAgentMetadata";

import { stripAceSideChatCommand } from "../../lib/chat/sideChatDraft";
import { resolveSubagentIdentity } from "../../lib/subagentAdapters";
import type { WorkLogEntry } from "../../session-logic/types";

export interface SubagentThread {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly model?: string;
  readonly persona: SubagentPersona;
  readonly roleLabel?: string;
  readonly status: "running" | "completed" | "failed";
  readonly entries: ReadonlyArray<WorkLogEntry>;
}

export interface SubagentPersona {
  readonly avatarClassName: string;
  readonly haloClassName: string;
  readonly initials: string;
  readonly name: string;
  readonly pingClassName: string;
}

export interface HierarchicalSubagentThread {
  readonly depth: number;
  readonly thread: SubagentThread;
}

function isSideChatEntry(entry: WorkLogEntry): boolean {
  return (
    isProviderSideConversationType(entry.subagentType) ||
    entry.subagentId?.trim().toLowerCase().startsWith("side:") === true ||
    hasSideChatCommandPrefix(entry.sideChatMessageText) ||
    hasSideChatCommandPrefix(entry.detail)
  );
}

export function isSideChatThread(thread: SubagentThread): boolean {
  return thread.entries.some(isSideChatEntry);
}

export function partitionSubagentThreads(threads: ReadonlyArray<SubagentThread>): {
  readonly providerSubagentThreads: SubagentThread[];
  readonly sideChatThreads: SubagentThread[];
} {
  const sideChatThreads: SubagentThread[] = [];
  const providerSubagentThreads: SubagentThread[] = [];
  for (const thread of threads) {
    if (isSideChatThread(thread)) {
      sideChatThreads.push(thread);
    } else {
      providerSubagentThreads.push(thread);
    }
  }
  return { providerSubagentThreads, sideChatThreads };
}

export function agentThreadsPanelTitle(threads: ReadonlyArray<SubagentThread>): string {
  const hasSideChats = threads.some(isSideChatThread);
  const hasSubagents = threads.some((thread) => !isSideChatThread(thread));

  if (hasSideChats && !hasSubagents) {
    return "Side chats";
  }
  if (hasSideChats) {
    return "Agent chats";
  }
  return "Subagents";
}

export function agentThreadsAddTabLabel(threads: ReadonlyArray<SubagentThread>): string | null {
  return threads.length > 0 ? agentThreadsPanelTitle(threads) : null;
}

export function canReplyToSubagentThread(
  thread: SubagentThread,
  providerThreadTargetingMode: ProviderIntegrationCapabilities["providerThreadTargetingMode"],
): boolean {
  return isSideChatThread(thread) || providerThreadTargetingMode === "native";
}

export function formatSubagentLabel(value: string | undefined): string | null {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function subagentThreadKey(entry: WorkLogEntry): string | null {
  if (isSideChatEntry(entry)) {
    return entry.subagentId ?? entry.sideChatMessageId ?? entry.id;
  }
  return entry.subagentId ?? entry.subagentName ?? entry.subagentType ?? null;
}

const GENERATED_SUBAGENT_NAMES = [
  "Ada Lovelint",
  "Alan Touring",
  "Marie Query",
  "Isaac Newtask",
  "Grace Hopperton",
  "Nikola Testla",
  "Rosie Franklin",
  "Katherine Johnsons",
  "Galileo Debuglei",
  "Hypatia Trace",
  "Albert Einsight",
  "Emmy Noteworthy",
  "Blaise Passcal",
  "Sophie Germainframe",
  "Claude Shannone",
  "Barbara Liskovitz",
  "Donald Knuthatch",
  "Noether Nullguard",
  "Carl Saganize",
  "Dorothy Vaughanilla",
] as const;

const SUBAGENT_PERSONA_TONES = [
  {
    avatarClassName: "bg-sky-500/14 text-sky-500 ring-sky-500/24",
    haloClassName: "bg-sky-500/14",
    pingClassName: "bg-sky-400",
  },
  {
    avatarClassName: "bg-emerald-500/14 text-emerald-500 ring-emerald-500/24",
    haloClassName: "bg-emerald-500/14",
    pingClassName: "bg-emerald-400",
  },
  {
    avatarClassName: "bg-amber-500/14 text-amber-500 ring-amber-500/24",
    haloClassName: "bg-amber-500/14",
    pingClassName: "bg-amber-400",
  },
  {
    avatarClassName: "bg-fuchsia-500/14 text-fuchsia-500 ring-fuchsia-500/24",
    haloClassName: "bg-fuchsia-500/14",
    pingClassName: "bg-fuchsia-400",
  },
] as const;

const PROVIDER_SIDE_CHAT_DISPLAY_PREFIX_PATTERN = /^(?:\.side|\/btw|\.btw)(?:\s+([\s\S]*))?$/i;
const SIDE_CHAT_COMMAND_PREFIX_PATTERN = /^(?:\/side|\.side|\/btw|\.btw)(?:\s|$)/i;
const SIDE_CHAT_PROMPT_EFFORT_PREFIX_PATTERN = /^Ultrathink:\s*/i;

function hasSideChatCommandPrefix(value: string | undefined): boolean {
  return SIDE_CHAT_COMMAND_PREFIX_PATTERN.test(value?.trim() ?? "");
}

export function formatSideChatRequestForDisplay(value: string): string {
  const withoutEffortPrefix = value.trim().replace(SIDE_CHAT_PROMPT_EFFORT_PREFIX_PATTERN, "");
  const aceCommandTitle = stripAceSideChatCommand(withoutEffortPrefix);
  const normalized = aceCommandTitle.replace(/\s+/g, " ").trim();
  const providerAliasMatch = PROVIDER_SIDE_CHAT_DISPLAY_PREFIX_PATTERN.exec(normalized);
  return (providerAliasMatch?.[1]?.trim() || normalized).trim();
}

function hashSubagentId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isGenericSubagentLabel(label: string): boolean {
  return /^(codex\s+)?subagent$/i.test(label.trim());
}

function initialsForName(name: string): string {
  const parts = name.replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0]?.slice(0, 2) ?? "AI").toUpperCase();
}

function sideChatTitleFromEntries(entries: ReadonlyArray<WorkLogEntry>): string | null {
  const firstUserMessage = entries
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .find(
      (entry) =>
        entry.sideChatMessageRole === "user" &&
        typeof entry.sideChatMessageText === "string" &&
        entry.sideChatMessageText.trim().length > 0,
    )?.sideChatMessageText;
  const normalized = firstUserMessage?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const withoutCommand = formatSideChatRequestForDisplay(normalized);
  if (withoutCommand.length <= 64) {
    return withoutCommand;
  }
  return `${withoutCommand.slice(0, 61).trimEnd()}...`;
}

function resolveGeneratedSubagentName(hash: number, usedNames: Set<string>): string {
  for (let offset = 0; offset < GENERATED_SUBAGENT_NAMES.length; offset += 1) {
    const candidate =
      GENERATED_SUBAGENT_NAMES[(hash + offset) % GENERATED_SUBAGENT_NAMES.length] ?? "Ada Lovelint";
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `Ada Lovelint ${usedNames.size + 1}`;
  usedNames.add(fallback);
  return fallback;
}

function resolveSubagentPersona(input: {
  id: string;
  identityLabel: string;
  usedNames: Set<string>;
}): SubagentPersona {
  const hash = hashSubagentId(input.id);
  const name = isGenericSubagentLabel(input.identityLabel)
    ? resolveGeneratedSubagentName(hash, input.usedNames)
    : input.identityLabel;
  input.usedNames.add(name);
  const tone =
    SUBAGENT_PERSONA_TONES[hash % SUBAGENT_PERSONA_TONES.length] ?? SUBAGENT_PERSONA_TONES[0];
  return {
    ...tone,
    initials: initialsForName(name),
    name,
  };
}

function resolveThreadStatus(entries: ReadonlyArray<WorkLogEntry>): SubagentThread["status"] {
  const latestStatus = entries
    .filter((entry) => entry.status)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.status;
  if (latestStatus === "inProgress") {
    return "running";
  }
  if (latestStatus === "completed") {
    return "completed";
  }
  if (latestStatus === "failed") {
    return "failed";
  }
  if (entries.some((entry) => entry.tone === "error")) {
    return "failed";
  }
  return "completed";
}

function resolveSubagentParentId(entries: ReadonlyArray<WorkLogEntry>): string | undefined {
  return entries
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .find((entry) => entry.subagentParentId?.trim())?.subagentParentId;
}

export function deriveSubagentThreads(
  entries: ReadonlyArray<WorkLogEntry>,
  provider?: ProviderKind | null,
): SubagentThread[] {
  const grouped = new Map<string, WorkLogEntry[]>();
  for (const entry of entries) {
    const key = subagentThreadKey(entry);
    if (!key) {
      continue;
    }
    const group = grouped.get(key);
    if (group) {
      group.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }

  const usedNames = new Set<string>();
  let sideChatIndex = 0;
  return [...grouped.entries()]
    .map(([id, group]) => {
      const identity = resolveSubagentIdentity({ entries: group, fallbackId: id, provider });
      const isSideChat = group.some(isSideChatEntry);
      const identityLabel = isSideChat
        ? (sideChatTitleFromEntries(group) ?? `Side chat ${++sideChatIndex}`)
        : identity.label;
      const persona = resolveSubagentPersona({ id, identityLabel, usedNames });
      const roleLabel = isSideChat || persona.name === identity.label ? null : identity.label;
      const parentId = resolveSubagentParentId(group);
      return {
        id,
        ...(parentId ? { parentId } : {}),
        label: persona.name,
        ...(identity.model ? { model: identity.model } : {}),
        persona,
        ...(roleLabel ? { roleLabel } : {}),
        status: resolveThreadStatus(group),
        entries: group.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    })
    .toSorted((left, right) => {
      const leftLast = left.entries.at(-1)?.createdAt ?? "";
      const rightLast = right.entries.at(-1)?.createdAt ?? "";
      return rightLast.localeCompare(leftLast);
    });
}

export function orderSubagentThreadsForHierarchy(
  threads: ReadonlyArray<SubagentThread>,
): HierarchicalSubagentThread[] {
  const remaining = [...threads];
  const emitted = new Set<string>();
  const ordered: HierarchicalSubagentThread[] = [];
  let madeProgress = true;

  while (remaining.length > 0 && madeProgress) {
    madeProgress = false;
    for (let index = 0; index < remaining.length; ) {
      const thread = remaining[index];
      if (!thread) {
        index += 1;
        continue;
      }
      const parentId = thread.parentId;
      const parentReady =
        !parentId || emitted.has(parentId) || !threads.some((item) => item.id === parentId);
      if (!parentReady) {
        index += 1;
        continue;
      }
      const parentDepth =
        parentId !== undefined
          ? (ordered.find((item) => item.thread.id === parentId)?.depth ?? -1)
          : -1;
      ordered.push({
        thread,
        depth: Math.min(parentDepth + 1, 2),
      });
      emitted.add(thread.id);
      remaining.splice(index, 1);
      madeProgress = true;
    }
  }

  for (const thread of remaining) {
    ordered.push({ thread, depth: thread.parentId ? 1 : 0 });
  }

  return ordered;
}

export function resolveSubagentMainAgentMessage(thread: SubagentThread): WorkLogEntry | null {
  return (
    thread.entries.find(
      (entry) =>
        entry.sideChatMessageRole === "user" &&
        typeof entry.sideChatMessageText === "string" &&
        entry.sideChatMessageText.trim().length > 0,
    ) ?? null
  );
}
