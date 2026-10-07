import { providerNames, type ReadinessView } from "@ace/ui-core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { Icon } from "@/components/icon.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ReadinessActions } from "@/features/sign-in/index.ts";

/**
 * One provider on the setup page: ready with a check, or the one thing that makes it ready
 * (sign in, reconnect, or the command that installs it). `next` marks the one card that needs
 * action and is setup's suggested step: it is highlighted and its button is the primary one.
 */
export function ProviderCard(props: {
  row: ProviderReadiness;
  view: ReadinessView;
  next: boolean;
}) {
  const { row, view, next } = props;
  const name = providerNames[row.provider];
  const install = view.state === "not_installed";
  return (
    <li
      aria-label={name}
      data-next={next ? "" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-card border bg-card px-4 py-3.5",
        next && "shadow-[0_0_0_2px_var(--ring)]",
      )}
    >
      <div className="flex items-center gap-3">
        <ProviderIcon provider={row.provider} size={20} decorative />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{name}</p>
          <p className="truncate text-sm text-muted-foreground">
            {[view.label, view.ready || install ? undefined : row.version]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {view.ready ? (
          <Icon icon={CheckCircleIcon} size={20} label="Ready" className="text-status-done" />
        ) : (
          <ReadinessActions
            provider={row.provider}
            name={name}
            view={view}
            emphasis={next ? "primary" : "secondary"}
          />
        )}
      </div>
      {!view.ready && view.detail && <p className="text-sm text-muted-foreground">{view.detail}</p>}
      {install && row.installCommand && <CopyCommand command={row.installCommand} />}
    </li>
  );
}
