import { providerNames, type ReadinessView } from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ReadinessAction } from "@/features/sign-in/index.ts";

/**
 * One agent on the setup page: its mark, its name and status, and either a green check (ready)
 * or the one thing that makes it ready. `next` marks setup's suggested step: ringed, and its
 * button is the primary one.
 */
export function ProviderCard(props: {
  row: ProviderReadiness;
  view: ReadinessView;
  next: boolean;
}) {
  const { row, view, next } = props;
  const name = providerNames[row.provider];
  return (
    <li
      aria-label={name}
      data-next={next ? "" : undefined}
      className={cn(
        "fx-rise-in flex flex-col justify-between gap-6 rounded-lg border bg-card p-4 transition-shadow duration-(--dur-2)",
        next && "shadow-[0_0_0_2px_var(--ring)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <ProviderTile provider={row.provider} />
        {view.ready ? (
          <span
            role="img"
            aria-label="Ready"
            data-tone="done"
            className="fx-pop grid size-7 place-items-center rounded-full bg-(--tone)/12 text-(--tone)"
          >
            <CheckIcon aria-hidden size={14} weight="bold" />
          </span>
        ) : (
          <ReadinessAction
            provider={row.provider}
            name={name}
            view={view}
            emphasis={next ? "primary" : "secondary"}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-base font-medium">{name}</p>
        <span className="text-sm text-muted-foreground">
          <StatusLine tone={view.tone} text={view.summary} />
        </span>
      </div>
    </li>
  );
}

/** An agent that isn't installed: one quiet row, its install command a click away. */
export function MissingRow(props: { row: ProviderReadiness; view: ReadinessView }) {
  const { row, view } = props;
  const name = providerNames[row.provider];
  const [open, setOpen] = useState(false);
  return (
    <li aria-label={name} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <ProviderTile provider={row.provider} size="sm" muted />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">Not installed</p>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          How to install
        </Button>
      </div>
      {open && (
        <div className="fx-rise-in pl-11 text-sm text-muted-foreground">
          {row.installCommand ? (
            <p className="flex flex-wrap items-center gap-1.5">
              Run <CopyCommand command={row.installCommand} /> in a terminal, then check again.
            </p>
          ) : (
            <p>{view.detail ?? `Install ${name} with its own installer, then check again.`}</p>
          )}
        </div>
      )}
    </li>
  );
}
