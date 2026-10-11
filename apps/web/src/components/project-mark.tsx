import { ProjectImage } from "./project-image.tsx";
import type { ProjectBadge } from "@ace/ui-core";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * The project's two letters on a quiet tile. The tile takes the project's tint
 * (`--project-<n>`, AA on every surface); only the variable is inline, the rule is shared.
 */
export function ProjectMark(props: {
  badge: ProjectBadge;
  icon?: string | null | undefined;
  quiet?: boolean | undefined;
}) {
  return (
    <ProjectImage
      icon={props.icon}
      className={cn(
        "h-4 w-5 shrink-0 rounded-xs object-contain",
        props.quiet && "grayscale opacity-75",
      )}
      fallback={
        <span
          aria-hidden
          style={{ "--tint": `var(--project-${props.badge.tint})` } as CSSProperties}
          className={cn(
            "inline-flex h-4 w-5 shrink-0 items-center justify-center rounded-xs text-[9px] leading-none font-semibold",
            props.quiet ? "bg-secondary text-subtle-foreground" : "bg-(--tint)/12 text-(--tint)",
          )}
        >
          {props.badge.initials}
        </span>
      }
    />
  );
}
