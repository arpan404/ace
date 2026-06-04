import type { ProviderKind } from "@ace/contracts";

import type { WorkLogEntry } from "../session-logic/types";

export interface SubagentIdentity {
  readonly label: string;
  readonly model?: string;
}

interface SubagentIdentityAdapter {
  readonly resolveIdentity: (
    entries: ReadonlyArray<WorkLogEntry>,
    fallbackId: string,
  ) => SubagentIdentity;
}

function formatSubagentLabel(value: string | undefined): string | null {
  const normalized = value
    ?.replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bagent$/i, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function firstEntryValue(
  entries: ReadonlyArray<WorkLogEntry>,
  read: (entry: WorkLogEntry) => string | undefined,
): string | undefined {
  for (const entry of entries) {
    const value = read(entry)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveGenericSubagentIdentity(
  entries: ReadonlyArray<WorkLogEntry>,
  fallbackId: string,
): SubagentIdentity {
  const model = firstEntryValue(entries, (entry) => entry.subagentModel);
  const label =
    formatSubagentLabel(firstEntryValue(entries, (entry) => entry.subagentName)) ??
    formatSubagentLabel(firstEntryValue(entries, (entry) => entry.subagentType)) ??
    formatSubagentLabel(fallbackId) ??
    "Subagent";
  return {
    label,
    ...(model ? { model } : {}),
  };
}

function resolveCodexSubagentIdentity(
  entries: ReadonlyArray<WorkLogEntry>,
  fallbackId: string,
): SubagentIdentity {
  const model = firstEntryValue(entries, (entry) => entry.subagentModel);
  const explicitName = formatSubagentLabel(firstEntryValue(entries, (entry) => entry.subagentName));
  if (explicitName) {
    return {
      label: explicitName,
      ...(model ? { model } : {}),
    };
  }

  const createdName = inferCodexCreatedSubagentName(entries);
  if (createdName) {
    return {
      label: createdName,
      ...(model ? { model } : {}),
    };
  }

  const type = firstEntryValue(entries, (entry) => entry.subagentType);
  const label = type && type.toLowerCase() !== "codex subagent" ? formatSubagentLabel(type) : null;
  return {
    label: label ?? "Codex Subagent",
    ...(model ? { model } : {}),
  };
}

function inferCodexCreatedSubagentName(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (const entry of entries) {
    const text = [entry.label, entry.detail, entry.intentText, entry.toolTitle]
      .filter((part): part is string => !!part)
      .join("\n");
    const match =
      /\bCreated\s+(?:[^\p{L}\p{N}\n\r(]+\s*)?(?<name>[\p{L}\p{N}][\p{L}\p{N}_-]{1,48})\s*(?:\(|with\b|$)/iu.exec(
        text,
      );
    const name = formatSubagentLabel(match?.groups?.name);
    if (name) {
      return name;
    }
  }
  return null;
}

const GENERIC_SUBAGENT_ADAPTER: SubagentIdentityAdapter = {
  resolveIdentity: resolveGenericSubagentIdentity,
};

const SUBAGENT_IDENTITY_ADAPTERS: Partial<Record<ProviderKind, SubagentIdentityAdapter>> = {
  codex: {
    resolveIdentity: resolveCodexSubagentIdentity,
  },
};

export function resolveSubagentIdentity(input: {
  readonly provider?: ProviderKind | null | undefined;
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly fallbackId: string;
}): SubagentIdentity {
  const adapter =
    (input.provider ? SUBAGENT_IDENTITY_ADAPTERS[input.provider] : undefined) ??
    GENERIC_SUBAGENT_ADAPTER;
  return adapter.resolveIdentity(input.entries, input.fallbackId);
}
