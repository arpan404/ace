import {
  newThreadModelList,
  newThreadPickerAgents,
  selectNewThreadAgent,
  type NewThreadAgents,
  type NewThreadChoice,
} from "@ace/ui-core/mobile";
import type { Preview } from "./agents.ts";

/*
 * New thread's `compose.agents` patch: every coding agent on the computer with its readiness and
 * reason (`newThreadPickerAgents`), and its models in the picker's order (`newThreadModelList`):
 * each account's default first, with `lead` rows before "More models". Bounded for the bridge
 * frame.
 */

export function agentsPatch(agents: NewThreadAgents, choice: NewThreadChoice, preview: Preview) {
  const start = selectNewThreadAgent(agents, {});
  const current = selectNewThreadAgent(agents, choice);
  return {
    type: "compose.agents",
    state: "ready",
    providers: newThreadPickerAgents(agents.providers, choice.provider).map((row) => {
      const inUse =
        current.ok && current.provider === row.provider
          ? { key: current.model.key, account: current.model.account }
          : undefined;
      const list = newThreadModelList(row.models.slice(0, 200), inUse);
      return {
        provider: row.provider,
        name: row.name,
        ready: row.ready,
        status: row.status,
        reason: row.reason ?? null,
        accounts: row.accounts.slice(0, 16).map((account) => ({
          id: account.id,
          label: preview(account.label, 128),
          usage: preview(account.usage, 128),
        })),
        models: list.models.map((model) => ({
          key: model.key,
          label: preview(model.label, 128),
          account: model.account,
          efforts: model.efforts,
          defaultEffort: model.defaultEffort ?? null,
          speeds: model.speeds,
          defaultSpeed: model.defaultSpeed,
        })),
        lead: list.lead,
      };
    }),
    start: start.ok
      ? {
          provider: start.provider,
          model: start.model.key,
          account: start.model.account,
          effort: start.effort ?? null,
        }
      : null,
  };
}
