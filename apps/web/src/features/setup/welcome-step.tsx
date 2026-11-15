import { providerNames } from "@ace/ui-core";
import { AceLogo } from "@/components/ace-logo.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { StepHeader } from "./step-header.tsx";
import type { useAgentCards } from "./use-agent-cards.ts";

/** What ace is, in a line, and what it already found on this computer. */
export function WelcomeStep(props: { agents: ReturnType<typeof useAgentCards> }) {
  const machine = usePrimaryMachine();
  const { installed, loading } = props.agents;
  return (
    <>
      <StepHeader
        mark={<AceLogo className="size-12" />}
        title="Welcome to ace"
        lede="Run the coding agents you already use side by side, and step in only when one needs you."
      />
      <div className="flex min-h-12 flex-col items-center gap-3">
        {loading ? (
          <Skeleton className="h-5 w-64" />
        ) : installed.length > 0 ? (
          <>
            <ul aria-label="Agents found" className="flex items-center gap-3">
              {installed.map(({ row }) => (
                <li key={row.provider} title={providerNames[row.provider]}>
                  <ProviderIcon provider={row.provider} size={20} />
                  <span className="sr-only">{providerNames[row.provider]}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              {found(installed.map(({ row }) => providerNames[row.provider]))} on {machine.name}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No agents found on {machine.name} yet</p>
        )}
      </div>
    </>
  );
}

/** "Claude Code, Codex and Pi found", or "3 agents found" past four names. */
function found(names: readonly string[]): string {
  if (names.length > 4) return `${names.length} agents found`;
  if (names.length === 1) return `${names[0]} found`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} found`;
}
