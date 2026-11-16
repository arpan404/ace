import { providerNames } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { usePrimaryMachine } from "@/lib/machines.ts";
import type { useAgentCards } from "./use-agent-cards.ts";

/** What ace already found on this computer. */
export function WelcomeStep(props: { agents: ReturnType<typeof useAgentCards> }) {
  const machine = usePrimaryMachine();
  const { installed, loading } = props.agents;
  return (
    <section aria-label="Agents found" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Found on {machine.name}</h2>
      {loading ? (
        <Skeleton className="h-5 w-64" />
      ) : installed.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {installed.map(({ row }) => (
            <li key={row.provider} className="flex items-center gap-2">
              <ProviderIcon provider={row.provider} size={16} />
              {providerNames[row.provider]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No agents yet. You can install one next.</p>
      )}
    </section>
  );
}
