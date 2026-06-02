import type { ProviderKind } from "@ace/contracts";

import { resolveSubagentIdentity } from "../../lib/subagentAdapters";
import type { WorkLogEntry } from "../../session-logic/types";

export interface SubagentThread {
  readonly id: string;
  readonly label: string;
  readonly model?: string;
  readonly status: "running" | "completed" | "failed";
  readonly entries: ReadonlyArray<WorkLogEntry>;
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

  return [...grouped.entries()]
    .map(([id, group]) => {
      const identity = resolveSubagentIdentity({ entries: group, fallbackId: id, provider });
      return {
        id,
        label: identity.label,
        ...(identity.model ? { model: identity.model } : {}),
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
