export type AgentAttentionNotificationKind = "approval" | "user-input" | "completion";

export type ApprovalNotificationRequestKind = "command" | "file-read" | "file-change";

export interface AgentAttentionNotificationTitleInput {
  readonly kind: AgentAttentionNotificationKind;
  readonly threadTitle: string;
  readonly maxLength?: number;
}

export interface ApprovalNotificationBodyInput {
  readonly requestKind: ApprovalNotificationRequestKind;
  readonly detail?: string | null;
  readonly maxLength?: number;
}

export interface UserInputNotificationBodyInput {
  readonly firstQuestion: string;
  readonly questionCount: number;
  readonly maxLength?: number;
}

export interface CompletionNotificationBodyInput {
  readonly assistantPreview?: string | null;
  readonly maxLength?: number;
}

const DEFAULT_NOTIFICATION_TITLE_MAX_CHARS = 96;
const DEFAULT_NOTIFICATION_BODY_MAX_CHARS = 160;

const ATTENTION_TITLE_ACTION_BY_KIND: Record<AgentAttentionNotificationKind, string> = {
  approval: "needs approval",
  "user-input": "needs input",
  completion: "finished",
};

const APPROVAL_BODY_LABEL_BY_KIND: Record<ApprovalNotificationRequestKind, string> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
};

const APPROVAL_FALLBACK_LABEL_BY_KIND: Record<ApprovalNotificationRequestKind, string> = {
  command: "command",
  "file-read": "file read",
  "file-change": "file change",
};

export function normalizeNotificationText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateNotificationText(
  text: string,
  maxLength = DEFAULT_NOTIFICATION_BODY_MAX_CHARS,
): string {
  const normalizedMaxLength = Math.max(0, Math.floor(maxLength));
  const trimmed = normalizeNotificationText(text);
  if (trimmed.length <= normalizedMaxLength) {
    return trimmed;
  }

  if (normalizedMaxLength <= 3) {
    return trimmed.slice(0, normalizedMaxLength);
  }

  return `${trimmed.slice(0, normalizedMaxLength - 3).trimEnd()}...`;
}

export function normalizeThreadNotificationTitle(title: string): string {
  const normalized = normalizeNotificationText(title);
  return normalized.length > 0 ? normalized : "Untitled thread";
}

export function buildAgentAttentionNotificationTitle(
  input: AgentAttentionNotificationTitleInput,
): string {
  const maxLength = Math.max(
    16,
    Math.floor(input.maxLength ?? DEFAULT_NOTIFICATION_TITLE_MAX_CHARS),
  );
  const action = ATTENTION_TITLE_ACTION_BY_KIND[input.kind];
  const separator = " ";
  const subjectMaxLength = Math.max(1, maxLength - action.length - separator.length);
  const subject = truncateNotificationText(
    normalizeThreadNotificationTitle(input.threadTitle),
    subjectMaxLength,
  );

  return truncateNotificationText(`${subject}${separator}${action}`, maxLength);
}

export function buildApprovalNotificationBody(input: ApprovalNotificationBodyInput): string {
  const detail = input.detail ? normalizeNotificationText(input.detail) : "";
  const body =
    detail.length > 0
      ? `${APPROVAL_BODY_LABEL_BY_KIND[input.requestKind]}: ${detail}`
      : `Review the ${APPROVAL_FALLBACK_LABEL_BY_KIND[input.requestKind]} approval request.`;

  return truncateNotificationText(body, input.maxLength ?? DEFAULT_NOTIFICATION_BODY_MAX_CHARS);
}

export function buildUserInputNotificationBody(input: UserInputNotificationBodyInput): string {
  const suffix =
    input.questionCount > 1 ? ` (${String(input.questionCount)} questions waiting)` : "";
  return truncateNotificationText(
    `${input.firstQuestion}${suffix}`,
    input.maxLength ?? DEFAULT_NOTIFICATION_BODY_MAX_CHARS,
  );
}

export function buildCompletionNotificationBody(input: CompletionNotificationBodyInput): string {
  const preview = input.assistantPreview ? normalizeNotificationText(input.assistantPreview) : "";
  return truncateNotificationText(
    preview.length > 0 ? preview : "The agent finished working.",
    input.maxLength ?? DEFAULT_NOTIFICATION_BODY_MAX_CHARS,
  );
}
