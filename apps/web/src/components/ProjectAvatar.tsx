import { IconTerminal } from "@tabler/icons-react";
import { BoxIcon, FlaskConicalIcon, FolderIcon, Code2Icon, RocketIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { Project, ProjectIcon } from "~/types";

import { ProjectFavicon } from "./ProjectFavicon";

const PROJECT_ICON_ACCENT_CLASS_NAMES: Record<ProjectIcon["color"], string> = {
  slate: "text-slate-500 dark:text-slate-300",
  blue: "text-sky-600 dark:text-sky-300",
  violet: "text-violet-600 dark:text-violet-300",
  emerald: "text-emerald-600 dark:text-emerald-300",
  amber: "text-amber-600 dark:text-amber-300",
  rose: "text-rose-600 dark:text-rose-300",
};

function iconComponentForGlyph(glyph: ProjectIcon["glyph"]) {
  switch (glyph) {
    case "terminal":
      return IconTerminal;
    case "code":
      return Code2Icon;
    case "flask":
      return FlaskConicalIcon;
    case "rocket":
      return RocketIcon;
    case "package":
      return BoxIcon;
    default:
      return FolderIcon;
  }
}

export function ProjectGlyphIcon({ icon, className }: { icon: ProjectIcon; className?: string }) {
  const Icon = iconComponentForGlyph(icon.glyph);
  return (
    <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}>
      <Icon
        className={cn("size-[92%]", PROJECT_ICON_ACCENT_CLASS_NAMES[icon.color])}
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeWidth={1.85}
      />
    </span>
  );
}

export function ProjectAvatar({
  project,
  className,
}: {
  project: Pick<Project, "cwd" | "icon">;
  className?: string;
}) {
  if (project.icon === null) {
    return className ? (
      <ProjectFavicon cwd={project.cwd} className={className} />
    ) : (
      <ProjectFavicon cwd={project.cwd} />
    );
  }

  return className ? (
    <ProjectGlyphIcon icon={project.icon} className={className} />
  ) : (
    <ProjectGlyphIcon icon={project.icon} />
  );
}
