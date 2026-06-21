import { AlertCircleIcon, LoaderCircleIcon, RefreshCwIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";

import { useConnectionHealth } from "~/lib/reliability/connectionHealth";
import { getWsRpcClient } from "~/wsRpcClient";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ConnectionHealthPillProps {
  onOpenDiagnostics: () => void;
  onRefreshProviders: () => void;
}

function formatTime(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ConnectionHealthPill({
  onOpenDiagnostics,
  onRefreshProviders,
}: ConnectionHealthPillProps) {
  const health = useConnectionHealth();
  const [open, setOpen] = useState(false);

  if (health.kind === "healthy") {
    return (
      <span
        className="inline-flex size-2 shrink-0 rounded-full bg-success/65"
        aria-label="Connection healthy"
      />
    );
  }

  const Icon = health.kind === "reconnecting" ? LoaderCircleIcon : AlertCircleIcon;
  const label =
    health.kind === "reconnecting"
      ? "Reconnecting"
      : health.kind === "disconnected"
        ? "Offline"
        : health.kind === "degraded"
          ? "Degraded"
          : "Connecting";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Connection ${label.toLowerCase()}`}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium",
              health.kind === "disconnected"
                ? "border-destructive/35 bg-destructive/8 text-destructive"
                : "border-warning/35 bg-warning/8 text-warning",
            )}
          />
        }
      >
        <Icon className={cn("size-3.5", health.kind === "reconnecting" && "animate-spin")} />
        {label}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 p-3">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Connection {label.toLowerCase()}</p>
            {health.lastError ? (
              <p className="mt-1 line-clamp-4 text-xs break-words text-muted-foreground">
                {health.lastError}
              </p>
            ) : null}
          </div>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Last connected</dt>
            <dd>{formatTime(health.lastConnectedAt)}</dd>
            <dt className="text-muted-foreground">Last offline</dt>
            <dd>{formatTime(health.lastDisconnectedAt)}</dd>
            <dt className="text-muted-foreground">Reconnects</dt>
            <dd>{health.reconnectCount}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => getWsRpcClient().queueProbeNow("health-pill")}
            >
              <RefreshCwIcon className="size-3" />
              Retry now
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onRefreshProviders}>
              <RefreshCwIcon className="size-3" />
              Refresh providers
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onOpenDiagnostics}>
              <WrenchIcon className="size-3" />
              Open diagnostics
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
