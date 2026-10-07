import { providerNames, readinessView } from "@ace/ui-core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { Icon } from "@/components/icon.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { ReadinessButton } from "@/features/sign-in/index.ts";

/**
 * One provider on the setup page: ready with a check, or the one thing that makes it ready
 * (sign in, sign in again, or the command that installs it). `next` marks the step setup
 * suggests first: its action is the page's primary one.
 */
export function ProviderCard(props: { row: ProviderReadiness; next: boolean }) {
  const { row, next } = props;
  const name = providerNames[row.provider];
  const view = readinessView(row);
  const install = view.action === "install";
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
          <ReadinessButton
            provider={row.provider}
            name={name}
            action={view.action}
            variant={next ? "primary" : "secondary"}
          />
        )}
      </div>
      {!view.ready && view.detail && <p className="text-sm text-muted-foreground">{view.detail}</p>}
      {install && row.installCommand && <CopyCommand command={row.installCommand} />}
    </li>
  );
}
