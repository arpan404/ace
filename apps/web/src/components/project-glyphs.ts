import type { ProjectGlyph } from "@ace/protocol";
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

/** The curated project badge glyphs, in the order the chooser offers them. */
export const projectGlyphs: readonly { glyph: ProjectGlyph; label: string; icon: Icon }[] = [
  { glyph: "code", label: "Code", icon: CodeIcon },
  { glyph: "terminal", label: "Terminal", icon: TerminalWindowIcon },
  { glyph: "globe", label: "Globe", icon: GlobeIcon },
  { glyph: "database", label: "Database", icon: DatabaseIcon },
  { glyph: "cloud", label: "Cloud", icon: CloudIcon },
  { glyph: "robot", label: "Robot", icon: RobotIcon },
  { glyph: "rocket", label: "Rocket", icon: RocketIcon },
  { glyph: "flask", label: "Flask", icon: FlaskIcon },
  { glyph: "book", label: "Book", icon: BookOpenIcon },
  { glyph: "cube", label: "Cube", icon: CubeIcon },
  { glyph: "game", label: "Game", icon: GameControllerIcon },
  { glyph: "mobile", label: "Phone", icon: DeviceMobileIcon },
  { glyph: "palette", label: "Palette", icon: PaletteIcon },
  { glyph: "gear", label: "Gear", icon: GearIcon },
  { glyph: "lightning", label: "Lightning", icon: LightningIcon },
  { glyph: "leaf", label: "Leaf", icon: LeafIcon },
  { glyph: "star", label: "Star", icon: StarIcon },
  { glyph: "heart", label: "Heart", icon: HeartIcon },
];

const byGlyph = new Map(projectGlyphs.map((entry) => [entry.glyph, entry]));

/** A stored glyph's drawing and name. */
export function projectGlyph(glyph: ProjectGlyph): { label: string; icon: Icon } | undefined {
  return byGlyph.get(glyph);
}
