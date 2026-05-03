import {
  ApprovalRequestId as ApprovalRequestIdSchema,
  type ApprovalRequestId,
  type OrchestrationThreadActivity,
  type UserInputQuestion,
} from "@ace/contracts";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly kind: "command" | "file-read" | "file-change";
  readonly summary: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly createdAt: string;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function payloadRequestId(payload: Record<string, unknown> | null): ApprovalRequestId | null {
  return typeof payload?.requestId === "string"
    ? ApprovalRequestIdSchema.makeUnsafe(payload.requestId)
    : null;
}

function payloadRequestKind(payload: Record<string, unknown> | null): PendingApproval["kind"] {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }

  if (payload?.requestType === "exec") {
    return "command";
  }
  if (payload?.requestType === "patch") {
    return "file-change";
  }
  return "file-read";
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortActivitiesBySequence(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  return activities.toSorted((left, right) => {
    const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const question = entry as Record<string, unknown>;
      const prompt = toNonEmptyString(question.question);
      if (!prompt) {
        return null;
      }

      const options = (Array.isArray(question.options) ? question.options : [])
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const optionRecord = option as Record<string, unknown>;
          const label = toNonEmptyString(optionRecord.label);
          if (!label) {
            return null;
          }
          return {
            label,
            description: toNonEmptyString(optionRecord.description) ?? label,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);

      if (question.multiSelect === true) {
        return {
          id: toNonEmptyString(question.id) ?? `question-${index + 1}`,
          header: toNonEmptyString(question.header) ?? `Question ${index + 1}`,
          question: prompt,
          options,
          multiSelect: true,
        };
      }

      return {
        id: toNonEmptyString(question.id) ?? `question-${index + 1}`,
        header: toNonEmptyString(question.header) ?? `Question ${index + 1}`,
        question: prompt,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();

  for (const activity of sortActivitiesBySequence(activities)) {
    const payload = activityPayload(activity);
    const requestId = payloadRequestId(payload);
    if (!requestId) {
      continue;
    }

    if (activity.kind === "approval.requested") {
      const detail = typeof payload?.detail === "string" ? payload.detail : null;
      openByRequestId.set(requestId, {
        requestId,
        kind: payloadRequestKind(payload),
        summary: activity.summary,
        detail,
        createdAt: activity.createdAt,
      });
      continue;
    }

    if (
      activity.kind === "approval.resolved" ||
      activity.kind === "provider.approval.respond.failed"
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();

  for (const activity of sortActivitiesBySequence(activities)) {
    const payload = activityPayload(activity);
    const requestId = payloadRequestId(payload);
    if (!requestId) {
      continue;
    }

    if (activity.kind === "user-input.requested") {
      const questions = parseUserInputQuestions(payload);
      if (questions) {
        openByRequestId.set(requestId, {
          requestId,
          questions,
          createdAt: activity.createdAt,
        });
      }
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }

    if (activity.kind === "provider.user-input.respond.failed") {
      const detail = typeof payload?.detail === "string" ? payload.detail : "";
      if (detail.toLowerCase().includes("stale pending user-input request")) {
        openByRequestId.delete(requestId);
      }
    }
  }

  return [...openByRequestId.values()];
}
