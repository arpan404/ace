import type { ProjectId, ServerLifecycleWelcomePayload, ThreadId } from "@ace/contracts";

export const LEAN_SNAPSHOT_RECOVERY_INPUT = {
  hydrateThreadId: null,
} as const;

export interface WelcomeBootstrapPlan {
  readonly shouldBootstrapFromSnapshot: boolean;
  readonly expandProjectId: ProjectId | null;
  readonly navigateToThreadId: ThreadId | null;
}

export function resolveWelcomeBootstrapPlan(input: {
  readonly bootstrapComplete: boolean;
  readonly pathname: string;
  readonly handledBootstrapThreadId: ThreadId | null;
  readonly payload: ServerLifecycleWelcomePayload;
}): WelcomeBootstrapPlan {
  const { bootstrapComplete, handledBootstrapThreadId, pathname, payload } = input;

  return {
    shouldBootstrapFromSnapshot: !bootstrapComplete,
    expandProjectId: payload.bootstrapProjectId ?? null,
    navigateToThreadId:
      payload.bootstrapProjectId &&
      payload.bootstrapThreadId &&
      pathname === "/" &&
      handledBootstrapThreadId !== payload.bootstrapThreadId
        ? payload.bootstrapThreadId
        : null,
  };
}
