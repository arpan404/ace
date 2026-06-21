import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function DeviceStatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit max-w-full shrink-0 items-center gap-1 self-start rounded-[var(--control-radius)] border px-1.5 text-[10px] font-medium uppercase tracking-wide",
        tone === "neutral" && "border-border/40 bg-background/42 text-muted-foreground",
        tone === "info" && "border-border/45 bg-foreground/[0.08] text-foreground/82",
        tone === "success" && "border-success/30 bg-success/10 text-success-foreground",
        tone === "warning" && "border-warning/35 bg-warning/10 text-warning-foreground",
        tone === "danger" && "border-destructive/35 bg-destructive/10 text-destructive-foreground",
      )}
    >
      {children}
    </span>
  );
}
