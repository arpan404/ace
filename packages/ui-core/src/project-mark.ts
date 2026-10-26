import type { BadgeColor, ProjectBadgeStyle, ProjectGlyph } from "@ace/protocol";

/** What a project's mark is drawn from: its own image, the badge chosen, the found favicon. */
export interface ProjectLook {
  icon?: string | null | undefined;
  defaultIcon?: string | null | undefined;
  badge?: ProjectBadgeStyle | undefined;
}

/**
 * What a project's mark shows, in every list, picker and preview. The person's own image wins;
 * else the badge they chose (a curated glyph, or the initials, in a curated colour); else the
 * folder's favicon; else the initials in the project's tint. A chosen badge hides the favicon.
 * An image that fails to load falls back to the glyph or initials, never to the favicon.
 */
export interface ProjectMark {
  image: string | undefined;
  glyph: ProjectGlyph | undefined;
  color: BadgeColor | undefined;
}

export function projectMark(look: ProjectLook | undefined): ProjectMark {
  const chosen = look?.badge;
  return {
    image: look?.icon ?? (chosen ? undefined : look?.defaultIcon) ?? undefined,
    glyph: chosen?.glyph,
    color: chosen?.color,
  };
}

/** Each curated project glyph's Phosphor icon name, for clients that draw icons by name. */
export const projectGlyphIcons: Readonly<Record<ProjectGlyph, string>> = {
  code: "code",
  terminal: "terminal-window",
  globe: "globe",
  database: "database",
  cloud: "cloud",
  robot: "robot",
  rocket: "rocket",
  flask: "flask",
  book: "book-open",
  cube: "cube",
  game: "game-controller",
  mobile: "device-mobile",
  palette: "palette",
  gear: "gear",
  lightning: "lightning",
  leaf: "leaf",
  star: "star",
  heart: "heart",
};
