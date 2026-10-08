import type { ScreenAgentScope, ScreenGrant, ScreenOperation } from "@ace/protocol";
import { screenProblem, visibleSessions, type StopAllState } from "@ace/ui-core/computer-use";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ScreenClientError, useScreenSession } from "./screen-session.ts";

export interface ScreenProblem {
  title: string;
  hint: string | undefined;
  /** The session it concerns, when it concerns one. */
  sessionId?: string | undefined;
  code: string | undefined;
}

/** A daemon refusal in words; `target_busy` names the holder from the session it reports. */
export function describeProblem(
  error: unknown,
  holderName?: (sessionId: string) => string | undefined,
): ScreenProblem {
  if (error instanceof ScreenClientError) {
    const holder = error.holder ? holderName?.(error.holder.sessionId) : undefined;
    return {
      ...screenProblem(error.errorCode, error.message, holder),
      code: error.errorCode,
      sessionId: error.holder?.sessionId,
    };
  }
  return {
    title: error instanceof Error ? error.message : "Computer use request failed",
    hint: undefined,
    code: undefined,
  };
}

/**
 * Computer use for whatever shows it: the channel's live state and every human control. Each
 * control is one request; a refusal becomes a toast (or, for the session it concerns, the
 * card's problem line). Stop all keeps its own state, pending then its outcome, for its button.
 * Nothing is retried on its own.
 */
export function useComputerUse() {
  const { session, snapshot, reconnect } = useScreenSession();
  const toast = useToast();
  const [pending, setPending] = useState(0);
  const [problems, setProblems] = useState<ReadonlyMap<string, ScreenProblem>>(new Map());
  const [stopping, setStopping] = useState<StopAllState>({ state: "idle" });
  const setProblem = (sessionId: string, problem: ScreenProblem | undefined) =>
    setProblems((current) => {
      const next = new Map(current);
      if (problem) next.set(sessionId, problem);
      else next.delete(sessionId);
      return next;
    });

  const run = async (
    operation: ScreenOperation,
    options: {
      failure: string;
      sessionId?: string;
      timeoutMs?: number;
      /** The page shows this failure where it happened (the permissions' own state). */
      inline?: boolean;
      /** The caller shows the failure itself; no toast. */
      onProblem?: (problem: ScreenProblem) => void;
    },
  ): Promise<unknown> => {
    if (!session) {
      const offline = "Computer use is offline.";
      if (options.onProblem)
        options.onProblem({ title: offline, hint: undefined, code: undefined });
      else toast.error({ title: options.failure, description: offline });
      return undefined;
    }
    setPending((count) => count + 1);
    if (options.sessionId) setProblem(options.sessionId, undefined);
    try {
      return (await session.request(operation, options.timeoutMs)) ?? null;
    } catch (error) {
      const problem = describeProblem(error);
      if (options.sessionId) setProblem(options.sessionId, problem);
      else if (options.onProblem) options.onProblem(problem);
      else if (!options.inline)
        toast.error({ title: options.failure, description: problem.hint ?? problem.title });
      return undefined;
    } finally {
      setPending((count) => count - 1);
    }
  };

  return {
    session,
    snapshot,
    reconnect,
    pending: pending > 0,
    problem: (sessionId: string) => problems.get(sessionId),
    stopping,
    enable: (enabled: boolean) => {
      setStopping({ state: "idle" });
      return run(
        { op: "enable", enabled },
        { failure: enabled ? "Couldn't turn on computer use" : "Couldn't turn off computer use" },
      );
    },
    stopAll: async () => {
      const count = visibleSessions(snapshot.states).length;
      let failed: ScreenProblem | undefined;
      setStopping({ state: "stopping" });
      await run(
        { op: "stop.all" },
        { failure: "Couldn't stop computer use", onProblem: (problem) => (failed = problem) },
      );
      setStopping(failed ? { state: "failed", reason: failed.title } : { state: "stopped", count });
    },
    requestPermission: (permission: "screenRecording" | "accessibility") =>
      run({ op: "permissions.request", permission }, { failure: "Couldn't ask macOS" }),
    refreshPermissions: () =>
      run({ op: "permissions" }, { failure: "Couldn't read permissions", inline: true }),
    takeover: (sessionId: string) =>
      run(
        { op: "controller", sessionId, controller: "human" },
        { failure: "Couldn't take over", sessionId },
      ),
    delegate: (sessionId: string, holder: ScreenAgentScope) =>
      run(
        { op: "controller", sessionId, controller: "agent", ...holder },
        { failure: "Couldn't hand it to the agent", sessionId },
      ),
    release: (sessionId: string) =>
      run(
        { op: "controller", sessionId, controller: "none" },
        { failure: "Couldn't release it", sessionId },
      ),
    background: (sessionId: string) =>
      run(
        { op: "mode", sessionId, mode: "background" },
        { failure: "Couldn't move it to the background", sessionId },
      ),
    secureInput: (sessionId: string, allowed: boolean) =>
      run(
        { op: "secure.input", sessionId, allowed },
        { failure: "Couldn't change secure input", sessionId },
      ),
    stop: (sessionId: string) =>
      run({ op: "stop", sessionId }, { failure: "Couldn't stop it", sessionId }),
    approveApp: (bundleId: string, threadId: string) =>
      run(
        { op: "approve", bundleId, allowed: true, scope: "thread", threadId },
        { failure: "Couldn't approve this app" },
      ),
    revoke: (grant: Pick<ScreenGrant, "bundleId" | "scope" | "threadId">) =>
      run(
        {
          op: "approve",
          bundleId: grant.bundleId,
          allowed: false,
          scope: grant.scope,
          ...(grant.threadId ? { threadId: grant.threadId } : {}),
        },
        { failure: "Couldn't revoke it" },
      ),
  };
}

export type ComputerUse = ReturnType<typeof useComputerUse>;
