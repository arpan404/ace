import { providerNames, type ReadinessView } from "@ace/ui-core";
import { useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ReadinessAction } from "@/features/sign-in/index.ts";

/** Providers share the same compact list density as past sessions. */
export function ProviderCard(props: {
  row: ProviderReadiness;
  view: ReadinessView;
  next: boolean;
}) {
  const { row, view, next } = props;
  const name = providerNames[row.provider];
  return (
    <li aria-label={name} className="flex h-9 min-w-0 items-center gap-3 text-sm">
      <ProviderIconTip provider={row.provider} size={14} />
      <span className="shrink-0 font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate">
        <StatusLine tone={view.tone} text={view.summary} />
      </span>
      {!view.ready && (
        <ReadinessAction
          provider={row.provider}
          name={name}
          view={view}
          emphasis={next ? "primary" : "secondary"}
        />
      )}
    </li>
  );
}

/** An agent that isn't installed: one quiet row, its install command a click away. */
export function MissingRow(props: { row: ProviderReadiness; view: ReadinessView }) {
  const { row, view } = props;
  const name = providerNames[row.provider];
  const [open, setOpen] = useState(false);
  return (
    <li aria-label={name} className="flex flex-col gap-2 py-1">
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
