import { lookup } from "node:dns/promises";
import type { BrowserOpen } from "@ace/protocol";
import type { BrowserServiceOptions } from "./service-options.ts";
import type { SessionOptions } from "./session-options.ts";
import type { BrowserSession } from "./session.ts";
import { BrowserOriginError, browserOrigin, allowedOrigin } from "./policy.ts";
import type { PolicyGate } from "./policy-call.ts";
import { reachesPrivateNetwork, type ResolveHost } from "./private-network.ts";

const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/** Approval lifetimes and origin provenance share the session's cancellation boundary. */
export function sessionPolicies(
  options: BrowserOpen,
  config: BrowserServiceOptions,
  signal: AbortSignal,
  gate: PolicyGate,
  current: () => BrowserSession | undefined,
) {
  /** False for a session kept off the local network, when `url` would reach it. */
  const reachable = async (url: string) =>
    !config.privateNetworkBlocked?.(options.threadId) ||
    !(await reachesPrivateNetwork(url, config.resolveHost ?? systemResolve));
  const allowed = async (
    url: string,
    originContext: { navigation?: boolean; human?: boolean } = {},
  ) => {
    const session = current();
    const task = session?.navigationTask;
    const policySignal = task ? AbortSignal.any([signal, task.signal]) : signal;
    const resume = originContext.navigation ? session?.policyWait(url) : undefined;
    try {
      const result =
        (await reachable(url)) &&
        (await allowedOrigin(
          options.threadId,
          url,
          config.originPolicy
            ? (originRequest) =>
                gate.run(
                  policySignal,
                  () => config.originPolicy?.({ ...originRequest, signal: policySignal }) ?? false,
                )
            : undefined,
          {
            ...originContext,
            human: originContext.human ?? session?.initiatingHuman() ?? false,
          },
        ));
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
    navigatePolicy: async (url, actor, commandSignal) => {
      const navigationSignal = commandSignal ? AbortSignal.any([signal, commandSignal]) : signal;
      if (!(await reachable(url))) return false;
      return allowedOrigin(
        options.threadId,
        url,
        config.originPolicy
          ? (originRequest) =>
              gate.run(navigationSignal, () => config.originPolicy?.(originRequest) ?? false)
          : undefined,
        {
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
    downloadAllowed: async (url: string) => {
      const policy = config.downloadPolicy;
      return !policy || gate.run(signal, () => policy(options.threadId, url, signal), 65_000);
    },
  };
}
