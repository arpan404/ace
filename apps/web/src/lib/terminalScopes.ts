import { type ProjectId, ThreadId, type ThreadId as ThreadIdType } from "@ace/contracts";

export type TerminalScopeKind = "workspace" | "thread";

const WORKSPACE_TERMINAL_SCOPE_PREFIX = "workspace-shell:";
const SCOPED_TERMINAL_UI_ID_SEPARATOR = "::";
const SCOPED_TERMINAL_GROUP_ID_SEPARATOR = "::";

export function workspaceTerminalScopeThreadId(projectId: ProjectId): ThreadIdType {
  return ThreadId.makeUnsafe(`${WORKSPACE_TERMINAL_SCOPE_PREFIX}${projectId}`);
}

export function isWorkspaceTerminalScopeThreadId(threadId: string): boolean {
  return threadId.startsWith(WORKSPACE_TERMINAL_SCOPE_PREFIX);
}

export function encodeScopedTerminalUiId(scope: TerminalScopeKind, terminalId: string): string {
  return `${scope}${SCOPED_TERMINAL_UI_ID_SEPARATOR}${terminalId}`;
}

export function decodeScopedTerminalUiId(
  value: string,
): { scope: TerminalScopeKind; terminalId: string } | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const splitIndex = value.indexOf(SCOPED_TERMINAL_UI_ID_SEPARATOR);
  if (splitIndex <= 0) {
    return null;
  }
  const rawScope = value.slice(0, splitIndex);
  if (rawScope !== "workspace" && rawScope !== "thread") {
    return null;
  }
  const terminalId = value.slice(splitIndex + SCOPED_TERMINAL_UI_ID_SEPARATOR.length);
  if (terminalId.length === 0) {
    return null;
  }
  return {
    scope: rawScope,
    terminalId,
  };
}

export function encodeScopedTerminalGroupId(scope: TerminalScopeKind, groupId: string): string {
  return `${scope}${SCOPED_TERMINAL_GROUP_ID_SEPARATOR}${groupId}`;
}

export function decodeScopedTerminalGroupId(
  value: string,
): { scope: TerminalScopeKind; groupId: string } | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const splitIndex = value.indexOf(SCOPED_TERMINAL_GROUP_ID_SEPARATOR);
  if (splitIndex <= 0) {
    return null;
  }
  const rawScope = value.slice(0, splitIndex);
  if (rawScope !== "workspace" && rawScope !== "thread") {
    return null;
  }
  const groupId = value.slice(splitIndex + SCOPED_TERMINAL_GROUP_ID_SEPARATOR.length);
  if (groupId.length === 0) {
    return null;
  }
  return {
    scope: rawScope,
    groupId,
  };
}
