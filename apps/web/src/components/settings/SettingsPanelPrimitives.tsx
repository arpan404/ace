import { Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { ServerProvider } from "@ace/contracts";

import { formatRelativeTime } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function maskEmailAddress(value: string): string {
  const [localPart, domainPart] = value.split("@");
  if (!localPart || !domainPart) {
    return value;
  }

  const maskedLocal =
    localPart.length <= 2
      ? `${localPart[0] ?? ""}*`
      : `${localPart.slice(0, 2)}${"*".repeat(Math.max(3, localPart.length - 3))}${
          localPart.slice(-1) || ""
        }`;

  const domainSegments = domainPart.split(".");
  const domainName = domainSegments[0] ?? "";
  const domainSuffix = domainSegments.slice(1).join(".");
  const maskedDomainName =
    domainName.length <= 1
      ? "*"
      : `${domainName[0]}${"*".repeat(Math.max(2, domainName.length - 1))}`;

  return domainSuffix.length > 0
    ? `${maskedLocal}@${maskedDomainName}.${domainSuffix}`
    : `${maskedLocal}@${maskedDomainName}`;
}

function renderAuthLabel(provider: ServerProvider): ReactNode {
  const authLabel = provider.auth.label ?? provider.auth.type;
  if (!authLabel) {
    return null;
  }

  if (provider.provider === "cursor" && authLabel.includes("@")) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="cursor-help">{maskEmailAddress(authLabel)}</span>}
        />
        <TooltipPopup side="top">{authLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return authLabel;
}

export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in ace.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = renderAuthLabel(provider);
    return {
      headline: authLabel ? <>Authenticated · {authLabel}</> : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function useRelativeTimeTick(intervalMs = 1_000) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

export function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/35">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

export function SettingsSection({
  title,
  description,
  icon,
  headerAction,
  contentClassName,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  headerAction?: ReactNode;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-col gap-2 px-0.5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h2 className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/62">
            {icon ? <span className="shrink-0 text-muted-foreground/65">{icon}</span> : null}
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          {description ? (
            <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground/52">
              {description}
            </p>
          ) : null}
        </div>
        {headerAction ? (
          <div className="flex min-h-7 shrink-0 items-center sm:justify-end">{headerAction}</div>
        ) : null}
      </div>
      <div
        className={cn(
          "relative min-w-0 overflow-hidden rounded-[var(--panel-radius)] border border-pill-border/58 bg-pill/58 text-card-foreground supports-[backdrop-filter]:bg-pill/48 supports-[backdrop-filter]:backdrop-blur-lg",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  controlClassName,
  tone = "default",
  children,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  controlClassName?: string;
  tone?: "default" | "warning" | "danger";
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-t border-pill-border/48 px-3 py-2.75 transition-colors duration-150 first:border-t-0 hover:bg-foreground/[0.018] sm:px-4",
        tone === "warning" && "bg-warning/[0.04]",
        tone === "danger" && "bg-destructive/[0.04]",
      )}
    >
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-h-5 min-w-0 items-center gap-1.5">
            <h3 className="min-w-0 text-[13px] leading-snug font-medium text-foreground/88">
              {title}
            </h3>
            {resetAction ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {resetAction}
              </span>
            ) : null}
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground/58">{description}</p>
          {status ? (
            <div className="pt-0.5 text-[11px] text-muted-foreground/60">{status}</div>
          ) : null}
        </div>
        {control ? (
          <div
            className={cn(
              "flex w-full min-w-0 shrink-0 items-center gap-2 md:w-auto md:justify-end",
              controlClassName,
            )}
          >
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-[var(--control-radius)] p-0 text-muted-foreground/55 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5 lg:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 sm:gap-5 [&_[data-slot=input-control]]:border-border/64 [&_[data-slot=input-control]]:bg-background/72 [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:px-2.5 [&_[data-slot=input]]:text-[12px] [&_[data-slot=input]]:leading-7 [&_[data-slot=select-button]]:rounded-[var(--control-radius)] [&_[data-slot=select-button]]:border-border/64 [&_[data-slot=select-button]]:bg-background/72 [&_button[data-slot=button]:not([data-size^=icon])]:h-7 [&_button[data-slot=button]:not([data-size^=icon])]:px-2.5 [&_button[data-slot=button]:not([data-size^=icon])]:text-[12px] [&_button[data-slot=button]]:rounded-[var(--control-radius)]">
        {children}
      </div>
    </div>
  );
}
