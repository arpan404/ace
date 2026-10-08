import { providerNames, type ReadinessView } from "@ace/ui-core";
import { useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { StatusLine } from "@/components/provider-tile.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ReadinessAction } from "@/features/sign-in/index.ts";

/** A provider's name, readiness and next action, as one quiet row. */
export function ProviderRow(props: { row: ProviderReadiness; view: ReadinessView; next: boolean }) {
  const { row, view, next } = props;
  const name = providerNames[row.provider];
  return (
    <li aria-label={name} className="flex h-9 items-center gap-2 text-sm">
      <ProviderIcon provider={row.provider} size={16} decorative />
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <StatusLine tone={view.tone} text={view.summary} className="max-w-[40%]" />
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
    <li aria-label={name} className="flex flex-col gap-2">
      <div className="flex h-9 items-center gap-2 text-sm">
        <ProviderIcon provider={row.provider} size={16} decorative />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <StatusLine tone={view.tone} text="Not installed" />
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
