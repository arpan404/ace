import { ProjectImage } from "./project-image.tsx";
import type { ProjectBadge } from "@ace/ui-core";
import type { ProjectBadgeStyle } from "@ace/protocol";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn.ts";
import { useProjectMetadata } from "@/lib/projects.ts";
import { accountColors } from "./ui/provider-account-icon.tsx";
import { projectGlyph } from "./project-glyphs.ts";

/** What a project's badge is drawn from: its own image, the badge chosen, the found favicon. */
export interface ProjectLook {
  icon?: string | null | undefined;
  defaultIcon?: string | null | undefined;
  badge?: ProjectBadgeStyle | undefined;
}

const sizes = {
  row: { tile: "h-4 w-5 rounded-xs text-2xs", glyph: 11 },
  large: { tile: "h-10 w-12 rounded-md text-base", glyph: 24 },
} as const;

/**
 * A project's badge exactly as the person set it, in every list, picker and preview: their own
 * image; else the badge they chose (initials or a curated glyph, in a curated colour); else the
 * folder's favicon; else the initials in the tint that stays with the project id. Only the tint
 * variable is inline; the rule is shared.
 */
export function ProjectMarkView(props: {
  badge: ProjectBadge;
  look: ProjectLook | undefined;
  quiet?: boolean | undefined;
  size?: keyof typeof sizes | undefined;
}) {
  const { look } = props;
  const size = sizes[props.size ?? "row"];
  const chosen = look?.badge;
  const Glyph = chosen?.glyph ? projectGlyph(chosen.glyph)?.icon : undefined;
  const tint = chosen?.color ? accountColors[chosen.color] : `var(--project-${props.badge.tint})`;
  const image = look?.icon ?? (chosen ? undefined : look?.defaultIcon);
  return (
    <ProjectImage
      icon={image}
      // Quiet marks recede whatever the person chose: a custom image goes grey and half-strength.
      className={cn(size.tile, "shrink-0 object-contain", props.quiet && "grayscale opacity-50")}
      fallback={
        <span
          aria-hidden
          data-project-mark=""
          style={{ "--tint": tint } as CSSProperties}
          className={cn(
            "inline-flex shrink-0 items-center justify-center leading-none font-semibold",
            size.tile,
            props.quiet ? "bg-secondary text-faint-foreground" : "bg-(--tint)/12 text-(--tint)",
          )}
        >
          {Glyph ? <Glyph aria-hidden size={size.glyph} weight="bold" /> : props.badge.initials}
        </span>
      }
    />
  );
}

/** The badge of a project this window's daemon lists, kept live with its edits. */
export function ProjectMark(props: {
  id: string;
  badge: ProjectBadge;
  quiet?: boolean | undefined;
}) {
  const project = useProjectMetadata()(props.id);
  return <ProjectMarkView badge={props.badge} look={project} quiet={props.quiet} />;
}
