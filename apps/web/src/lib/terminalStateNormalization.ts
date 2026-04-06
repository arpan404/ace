import { DEFAULT_THREAD_TERMINAL_ID, type ThreadTerminalGroup } from "../types";

export const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 236;
export const MIN_TERMINAL_SIDEBAR_WIDTH = 180;
export const MAX_TERMINAL_SIDEBAR_WIDTH = 360;

export function normalizeTerminalIdList(
  terminalIds: ReadonlyArray<string>,
  fallbackTerminalId = DEFAULT_THREAD_TERMINAL_ID,
): string[] {
  const normalized = normalizeOptionalTerminalIdList(terminalIds);
  return normalized.length > 0 ? normalized : [fallbackTerminalId];
}

export function normalizeOptionalTerminalIdList(
  terminalIds: ReadonlyArray<string>,
  validTerminalIds?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawTerminalId of terminalIds) {
    const terminalId = rawTerminalId.trim();
    if (terminalId.length === 0 || seen.has(terminalId)) {
      continue;
    }
    if (validTerminalIds && !validTerminalIds.has(terminalId)) {
      continue;
    }
    seen.add(terminalId);
    normalized.push(terminalId);
  }

  return normalized;
}

export function normalizeTerminalSidebarWidth(width: number | null | undefined): number {
  const safeWidth =
    typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_TERMINAL_SIDEBAR_WIDTH;
  return Math.min(
    MAX_TERMINAL_SIDEBAR_WIDTH,
    Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(safeWidth)),
  );
}

export function fallbackTerminalGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

export function assignUniqueTerminalGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

export function normalizeTerminalGroups(
  terminalGroups: ReadonlyArray<ThreadTerminalGroup>,
  terminalIds: ReadonlyArray<string>,
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeOptionalTerminalIdList(
      group.terminalIds,
      validTerminalIdSet,
    ).filter((terminalId) => {
      if (assignedTerminalIds.has(terminalId)) {
        return false;
      }
      return true;
    });
    if (groupTerminalIds.length === 0) {
      continue;
    }

    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }

    const trimmedGroupId = group.id.trim();
    const baseGroupId =
      trimmedGroupId.length > 0
        ? trimmedGroupId
        : fallbackTerminalGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueTerminalGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) {
      continue;
    }
    nextGroups.push({
      id: assignUniqueTerminalGroupId(fallbackTerminalGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length > 0) {
    return nextGroups;
  }

  return [
    {
      id: fallbackTerminalGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ];
}
