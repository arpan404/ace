import {
  BoxIcon,
  FlaskConicalIcon,
  FolderIcon,
  Code2Icon,
  RocketIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { Project, ProjectIcon } from "~/types";

import { ProjectFavicon } from "./ProjectFavicon";

type ProjectIconOption = {
  readonly glyph: ProjectIcon["glyph"];
  readonly label: string;
};

type ProjectIconColorOption = {
  readonly color: ProjectIcon["color"];
  readonly label: string;
  readonly swatchClassName: string;
};

export const PROJECT_ICON_OPTIONS: ReadonlyArray<ProjectIconOption> = [
  { glyph: "folder", label: "Folder" },
  { glyph: "terminal", label: "Terminal" },
  { glyph: "code", label: "Code" },
  { glyph: "flask", label: "Flask" },
  { glyph: "rocket", label: "Rocket" },
  { glyph: "package", label: "Package" },
];

export const PROJECT_ICON_COLOR_OPTIONS: ReadonlyArray<ProjectIconColorOption> = [
  { color: "slate", label: "Slate", swatchClassName: "bg-slate-500" },
  { color: "blue", label: "Blue", swatchClassName: "bg-sky-500" },
  { color: "violet", label: "Violet", swatchClassName: "bg-violet-500" },
  { color: "emerald", label: "Emerald", swatchClassName: "bg-emerald-500" },
  { color: "amber", label: "Amber", swatchClassName: "bg-amber-500" },
  { color: "rose", label: "Rose", swatchClassName: "bg-rose-500" },
];

const PROJECT_ICON_COLOR_CLASS_NAMES: Record<ProjectIcon["color"], string> = {
  slate:
    "border-slate-500/18 bg-slate-500/12 text-slate-700 dark:border-slate-400/18 dark:bg-slate-300/14 dark:text-slate-100",
  blue: "border-sky-500/18 bg-sky-500/12 text-sky-700 dark:border-sky-400/20 dark:bg-sky-300/14 dark:text-sky-100",
  violet:
    "border-violet-500/18 bg-violet-500/12 text-violet-700 dark:border-violet-400/20 dark:bg-violet-300/14 dark:text-violet-100",
  emerald:
    "border-emerald-500/18 bg-emerald-500/12 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-300/14 dark:text-emerald-100",
  amber:
    "border-amber-500/18 bg-amber-500/12 text-amber-700 dark:border-amber-400/20 dark:bg-amber-300/14 dark:text-amber-100",
  rose: "border-rose-500/18 bg-rose-500/12 text-rose-700 dark:border-rose-400/20 dark:bg-rose-300/14 dark:text-rose-100",
};

function iconComponentForGlyph(glyph: ProjectIcon["glyph"]) {
  switch (glyph) {
    case "terminal":
      return SquareTerminalIcon;
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
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-md border",
        PROJECT_ICON_COLOR_CLASS_NAMES[icon.color],
        className,
      )}
    >
      <Icon className="size-[65%]" />
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
