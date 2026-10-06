import type { BrowserOpen } from "@ace/protocol";
import type { BrowserServiceOptions } from "./service-options.ts";
import type { SessionOptions } from "./session-options.ts";
import type { BrowserSession } from "./session.ts";
import { BrowserOriginError, browserOrigin, allowedOrigin } from "./policy.ts";
import type { PolicyGate } from "./policy-call.ts";

/** Approval lifetimes and origin provenance share the session's cancellation boundary. */
export function sessionPolicies(
  options: BrowserOpen,
  config: BrowserServiceOptions,
  signal: AbortSignal,
  gate: PolicyGate,
  current: () => BrowserSession | undefined,
) {
  const allowed = async (
    url: string,
    originContext: { navigation?: boolean; human?: boolean } = {},
  ) => {
    const session = current();
    const task = session?.navigationTask;
    const policySignal = task ? AbortSignal.any([signal, task.signal]) : signal;
    const resume = originContext.navigation ? session?.policyWait(url) : undefined;
    try {
      const result = await allowedOrigin(
        options.threadId,
        url,
        config.originPolicy
          ? (originRequest) =>
              gate.run(
                policySignal,
                () => config.originPolicy?.({ ...originRequest, signal: policySignal }) ?? false,
                config.origins ? 65_000 : 10_000,
              )
          : undefined,
        {
          ...originContext,
          manageLoopback: config.origins !== undefined,
          human: originContext.human ?? session?.initiatingHuman() ?? false,
        },
      );
      if (!result && originContext.navigation)
        session?.blockedNavigation(
          {
            origin: browserOrigin(url) ?? url.slice(0, 8192),
            reason: browserOrigin(url) ? "approval_required" : "invalid_origin",
          },
          task,
        );
      return result;
    } catch (error) {
      if (originContext.navigation && error instanceof BrowserOriginError)
        session?.blockedNavigation(error.blocked, task);
      throw error;
    } finally {
      resume?.();
    }
  };
  const session: Pick<
    SessionOptions,
    "navigatePolicy" | "evaluatePolicy" | "artifactAllowed" | "workspaceRoot" | "uploadPolicy"
  > = {
    navigatePolicy: (url, actor, commandSignal) => {
      config.onNavigation?.(options.threadId);
      const navigationSignal = commandSignal ? AbortSignal.any([signal, commandSignal]) : signal;
      return allowedOrigin(
        options.threadId,
        url,
        config.originPolicy
          ? (originRequest) =>
              gate.run(
                navigationSignal,
                () => config.originPolicy?.(originRequest) ?? false,
                config.origins ? 65_000 : 10_000,
              )
          : undefined,
        {
          manageLoopback: config.origins !== undefined,
          human: actor.kind === "human",
          navigation: true,
          signal: navigationSignal,
        },
      );
    },
    ...(config.evaluatePolicy
      ? {
          evaluatePolicy: (
            threadId: string,
            url: string,
            mode?: "read-only" | "unrestricted",
            expression?: string,
            commandSignal?: AbortSignal,
          ) => {
            const approvalSignal = commandSignal
              ? AbortSignal.any([signal, commandSignal])
              : signal;
            return gate
              .run(
                approvalSignal,
                () =>
                  config.evaluatePolicy?.(threadId, url, approvalSignal, mode, expression) ?? false,
                65_000,
              )
              .catch((error) => {
                commandSignal?.throwIfAborted();
                throw error;
              });
          },
        }
      : {}),
    ...(config.artifactAllowed
      ? {
          artifactAllowed: (path: string) =>
            config.artifactAllowed?.(options.threadId, path) ?? false,
        }
      : {}),
    ...(config.workspaceRoot
      ? { workspaceRoot: () => config.workspaceRoot?.(options.threadId) ?? "" }
      : {}),
    ...(config.uploadPolicy
      ? {
          uploadPolicy: (paths: string[], commandSignal?: AbortSignal) => {
            const approvalSignal = commandSignal
              ? AbortSignal.any([signal, commandSignal])
              : signal;
            return gate.run(
              approvalSignal,
              () => config.uploadPolicy?.(options.threadId, paths, approvalSignal) ?? false,
              65_000,
            );
          },
        }
      : {}),
  };
  return {
    allowed,
    session,
    downloadAllowed: (url: string) =>
      gate.run(
        signal,
        () => config.downloadPolicy?.(options.threadId, url, signal) ?? false,
        65_000,
      ),
  };
}
