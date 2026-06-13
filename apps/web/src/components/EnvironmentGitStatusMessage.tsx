import type { ReactNode } from "react";
import { AlertTriangleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Spinner } from "./ui/spinner";

export function EnvironmentGitStatusMessage({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "error";
}) {
  const Icon = tone === "muted" ? Spinner : AlertTriangleIcon;
  return (
    <output
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-[11px] leading-4",
        tone === "muted" && "bg-muted/18 text-muted-foreground",
        tone === "warning" && "bg-warning/8 text-warning",
        tone === "error" && "bg-destructive/8 text-destructive",
      )}
      {...(tone === "muted" ? { "aria-live": "polite" as const } : { role: "status" })}
    >
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </output>
  );
}
