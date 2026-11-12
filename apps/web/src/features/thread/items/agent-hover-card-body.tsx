import { providerAccount, providerNames, subagentLabels } from "@ace/ui-core";
import type { ReactNode } from "react";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { cn } from "@/lib/cn.ts";
import { useAccountViews } from "@/lib/account-views.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { AgentIcon, type AgentMark } from "./agent-lead.tsx";
import { subagentTones, type AgentRowParts } from "./agent-row.tsx";

/** Mounted only while the card is open, so a closed row reads nothing extra. */
export function CardBody(props: { parts: AgentRowParts }) {
  const { parts } = props;
  const account = useAccountLabel(parts.mark);
  const here = usePrimaryMachine();
  // The model and effort as the row's meta reads them, without the row's own word for its kind.
  const model = parts.meta?.replace(/^(Delegated|New thread)( · )?/, "");
  const runs = [account, model || undefined].filter(Boolean).join(" · ");
  const made = runs || (parts.mark.provider ? providerNames[parts.mark.provider] : undefined);
  return (
    <div className="flex flex-col gap-1 text-ui">
      <div className="flex min-w-0 items-baseline gap-3">
        <p
          className="min-w-0 flex-1 truncate leading-5 font-medium text-foreground"
          title={parts.name}
        >
          {parts.name}
        </p>
        <p
          data-tone={subagentTones[parts.state]}
          className="flex shrink-0 items-baseline gap-1.5 text-xs text-(--tone-text)"
        >
          {subagentLabels[parts.state]}
          {parts.elapsed && (
            <span className="text-subtle-foreground tabular-nums">{parts.elapsed}</span>
          )}
        </p>
      </div>
      <div className="flex flex-col text-muted-foreground">
        {made && (
          <Fact>
            <AgentIcon {...parts.mark} size={16} className="text-muted-foreground" />
            <span className="min-w-0 truncate">{made}</span>
          </Fact>
        )}
        <Fact>
          <MachineMark icon={parts.machine ? undefined : here.icon} primary={!parts.machine} />
          <span className="min-w-0 truncate">{parts.machine ?? here.name}</span>
        </Fact>
      </div>
      {/* Its latest turn, the row's second line whole: what it does now, what it found, what it
          waits on, or why it failed. */}
      {parts.detail && (
        <p
          data-detail={parts.detailKind}
          className={cn(
            "mt-1 max-h-32 overflow-y-auto border-t border-border pt-2 whitespace-pre-line",
            parts.detailKind === "failed"
              ? "text-status-failed"
              : parts.detailKind === "live" || parts.detailKind === "human"
                ? "text-foreground"
                : "text-muted-foreground",
          )}
        >
          {parts.detail}
        </p>
      )}
    </div>
  );
}

/** One line of the card: its glyph, then its words. */
function Fact(props: { children: ReactNode }) {
  return <div className="flex min-h-6 min-w-0 items-center gap-1.5">{props.children}</div>;
}

/**
 * The name of the account the row's mark wears: one of this window's accounts, or of the
 * machine the agent runs on.
 */
function useAccountLabel(mark: AgentMark): string | undefined {
  const here = useAccountViews();
  if (!mark.provider || !mark.instance) return undefined;
  return providerAccount(mark.accounts ?? here.data, {
    provider: mark.provider,
    instance: mark.instance,
  }).account?.label;
}
