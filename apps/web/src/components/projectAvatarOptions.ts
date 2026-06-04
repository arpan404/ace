import type { ProjectIcon } from "~/types";

export type ProjectIconOption = {
  readonly glyph: ProjectIcon["glyph"];
  readonly label: string;
};

export type ProjectIconColorOption = {
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
