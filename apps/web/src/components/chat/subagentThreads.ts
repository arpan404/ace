import type { ProviderIntegrationCapabilities, ProviderKind } from "@ace/contracts";

import { resolveSubagentIdentity } from "../../lib/subagentAdapters";
import type { WorkLogEntry } from "../../session-logic/types";

export interface SubagentThread {
  readonly id: string;
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

function isSideChatEntry(entry: WorkLogEntry): boolean {
  return (
    entry.subagentType?.trim().toLowerCase() === "side chat" ||
    entry.subagentId?.trim().toLowerCase().startsWith("side:") === true
  );
}

export function isSideChatThread(thread: SubagentThread): boolean {
  return thread.entries.some(isSideChatEntry);
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
  if (entries.some((entry) => entry.status === "failed" || entry.tone === "error")) {
    return "failed";
  }
  if (entries.some((entry) => entry.status === "completed")) {
    return "completed";
  }
  const latestStatus = entries
    .filter((entry) => entry.status)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.status;
  if (latestStatus === "inProgress") {
    return "running";
  }
  return "completed";
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
      const identityLabel = isSideChat ? `Side chat ${++sideChatIndex}` : identity.label;
      const persona = resolveSubagentPersona({ id, identityLabel, usedNames });
      const roleLabel = isSideChat || persona.name === identity.label ? null : identity.label;
      return {
        id,
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
