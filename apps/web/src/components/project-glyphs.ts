import type { ProjectGlyph } from "@ace/protocol";
import { pinnedGlyph } from "./icon.tsx";
import {
  BookOpenIcon,
  CloudIcon,
  CodeIcon,
  CubeIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  FlaskIcon,
  GameControllerIcon,
  GearIcon,
  GlobeIcon,
  HeartIcon,
  LeafIcon,
  LightningIcon,
  PaletteIcon,
  RobotIcon,
  RocketIcon,
  StarIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";

// Bold in a project's mark, regular in the chooser: all the build keeps of a glyph only this table
// draws (`glyphTables` in `icon-weights.ts`).
const pinned = (icon: Icon) => pinnedGlyph(icon, ["regular", "bold"]);

/** The curated project badge glyphs, in the order the chooser offers them. */
export const projectGlyphs: readonly { glyph: ProjectGlyph; label: string; icon: Icon }[] = [
  { glyph: "code", label: "Code", icon: pinned(CodeIcon) },
  { glyph: "terminal", label: "Terminal", icon: pinned(TerminalWindowIcon) },
  { glyph: "globe", label: "Globe", icon: pinned(GlobeIcon) },
  { glyph: "database", label: "Database", icon: pinned(DatabaseIcon) },
  { glyph: "cloud", label: "Cloud", icon: pinned(CloudIcon) },
  { glyph: "robot", label: "Robot", icon: pinned(RobotIcon) },
  { glyph: "rocket", label: "Rocket", icon: pinned(RocketIcon) },
  { glyph: "flask", label: "Flask", icon: pinned(FlaskIcon) },
  { glyph: "book", label: "Book", icon: pinned(BookOpenIcon) },
  { glyph: "cube", label: "Cube", icon: pinned(CubeIcon) },
  { glyph: "game", label: "Game", icon: pinned(GameControllerIcon) },
  { glyph: "mobile", label: "Phone", icon: pinned(DeviceMobileIcon) },
  { glyph: "palette", label: "Palette", icon: pinned(PaletteIcon) },
  { glyph: "gear", label: "Gear", icon: pinned(GearIcon) },
  { glyph: "lightning", label: "Lightning", icon: pinned(LightningIcon) },
  { glyph: "leaf", label: "Leaf", icon: pinned(LeafIcon) },
  { glyph: "star", label: "Star", icon: pinned(StarIcon) },
  { glyph: "heart", label: "Heart", icon: pinned(HeartIcon) },
];

const byGlyph = new Map(projectGlyphs.map((entry) => [entry.glyph, entry]));

/** A stored glyph's drawing and name. */
export function projectGlyph(glyph: ProjectGlyph): { label: string; icon: Icon } | undefined {
  return byGlyph.get(glyph);
}
