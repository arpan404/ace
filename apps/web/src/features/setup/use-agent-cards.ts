import type { ReadinessView } from "@ace/ui-core";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import { useOnboarding, type ProviderReadiness } from "@/lib/provider-readiness.ts";

export interface AgentCard {
  row: ProviderReadiness;
  view: ReadinessView;
}

/**
 * The agents setup shows: each provider as Settings says it, with the catalog deciding whether
 * a CLI that doesn't report its sign-in works (ready when it lists models). Installed ones and
 * missing ones apart, and which installed one to highlight: the daemon's suggestion when it
 * needs action, else the first that does; none once one is ready.
 */
export function useAgentCards() {
  const onboarding = useOnboarding();
  const { model } = useProviderAccountModels();
  const data = onboarding.data;
  const cards: AgentCard[] = (data?.providers ?? [])
    .filter((row) => row.provider !== "acp")
    .flatMap((row) => {
      const view = model(row.provider).view;
      return view ? [{ row, view }] : [];
    });
  const installed = cards.filter((card) => card.view.state !== "not_installed");
  const missing = cards.filter((card) => card.view.state === "not_installed");
  const ready = installed.filter((card) => card.view.ready);
  const actionable = installed.filter((card) => card.view.primary);
  const next = ready.length
    ? undefined
    : (actionable.find((card) => card.row.provider === data?.next.provider) ?? actionable[0])?.row
        .provider;
  return {
    loading: !data && !onboarding.isError,
    failed: onboarding.isError,
    installed,
    missing,
    ready,
    next,
  };
}
