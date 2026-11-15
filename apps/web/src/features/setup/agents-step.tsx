import { useClient } from "@ace/client-react";
import { ArrowClockwiseIcon, TerminalIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { part } from "@/lib/suit-part.ts";
import { ProviderRow } from "./provider-card.tsx";
import { StepHeader } from "./step-header.tsx";
import type { useAgentCards } from "./use-agent-cards.ts";

/**
 * The agents on the daemon's computer, each with its status and the one step that readies it.
 * Rows update as sign-ins finish anywhere; one ready agent is enough to go on.
 */
export function AgentsStep(props: { agents: ReturnType<typeof useAgentCards> }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const machine = usePrimaryMachine();
  const [checking, setChecking] = useState(false);
  const { installed, missing, ready, next, loading, failed } = props.agents;
  const checkAgain = async () => {
    setChecking(true);
    try {
      await client.request({ type: "providers.request", operation: "refresh" });
    } catch {
      // Offline: the reconnect reads providers again anyway.
    }
    refreshProviders(queryClient);
    setChecking(false);
  };
  return (
    <>
      <StepHeader
        mark={<TerminalIcon aria-hidden size={36} />}
        title="Connect your agents"
        lede={
          ready.length
            ? `${ready.length} ready. Sign in to more now or later in Settings.`
            : "Sign in to one to start."
        }
      />
      <div className="flex w-full flex-col gap-6">
        {failed ? (
          <p role="alert" className="text-ui text-muted-foreground">
            This computer can't list its agents yet. Check Settings → Providers.
          </p>
        ) : loading ? (
          <ListSkeleton label="providers" shape="row" rows={4} />
        ) : (
          <>
            <section aria-label={`On ${machine.name}`} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-muted-foreground">On {machine.name}</h3>
                <IconButton
                  size="sm"
                  icon={ArrowClockwiseIcon}
                  label={checking ? "Checking…" : "Check again"}
                  disabled={checking}
                  onClick={() => void checkAgain()}
                />
              </div>
              {installed.length > 0 ? (
                <ul
                  aria-label="Providers on this computer"
                  {...part("list", undefined, "providers")}
                  className="divide-y"
                >
                  {installed.map(({ row, view }) => (
                    <ProviderRow
                      key={row.provider}
                      row={row}
                      view={view}
                      next={next === row.provider}
                    />
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-sm text-muted-foreground">
                  None installed yet. Install one below.
                </p>
              )}
            </section>
            {missing.length > 0 && (
              <section
                aria-label="Not installed"
                {...part("page-section", undefined, "not-installed")}
                className="flex flex-col gap-1"
              >
                <h3 className="text-sm font-medium text-muted-foreground">
                  {installed.length ? "More agents" : "Install an agent"}
                </h3>
                <ul {...part("list", undefined, "providers")} className="divide-y">
                  {missing.map(({ row, view }) => (
                    <ProviderRow key={row.provider} row={row} view={view} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
