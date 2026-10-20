import type { Agent, Thread } from "@ace/protocol";
import {
  effortLabel,
  formatClock,
  isPlainCliLogin,
  modelLabel,
  optionEffort,
  providerNames,
} from "@ace/ui-core";
import { useAccountViews } from "@/lib/account-views.ts";

/** What an agent runs on: the model and effort recorded for it, never guessed. */
export function agentModelLine(model: string | undefined, effort: string | undefined): string {
  return [model && modelLabel(model), effort && effortLabel(effort)].filter(Boolean).join(" · ");
}

/**
 * An agent's provider account, model and times, for its row and the row's tooltip. The main agent
 * runs on the thread's own selection (model, effort, account). A subagent of the thread's provider
 * runs in the same CLI login, so it shares the account; its model is what the provider recorded
 * for it, and its effort shows only when recorded (subagents don't report one).
 */
export function useAgentDetails(
  thread: Pick<Thread, "provider" | "execution"> | undefined,
  agent: Pick<Agent, "origin" | "model" | "native" | "createdAt" | "endedAt"> | undefined,
): { instance: string | undefined; model: string; lines: string[] } {
  const accounts = useAccountViews();
  if (!agent) return { instance: undefined, model: "", lines: [] };
  const root = agent.origin === "root";
  const selection = thread?.execution;
  const sameProvider = selection?.provider === agent.native.provider;
  const instance = sameProvider ? selection?.instanceId : undefined;
  const model = agentModelLine(
    agent.model ?? (root && sameProvider ? selection?.model : undefined),
    root && sameProvider ? optionEffort(selection?.options) : undefined,
  );
  const account = instance ? accounts.data?.find((entry) => entry.id === instance) : undefined;
  const provider = [
    providerNames[agent.native.provider],
    account && !isPlainCliLogin(account) ? account.label : undefined,
    model || undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const times = [
    `Started ${formatClock(agent.createdAt)}`,
    agent.endedAt === undefined ? undefined : `finished ${formatClock(agent.endedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { instance, model, lines: [provider, times] };
}
