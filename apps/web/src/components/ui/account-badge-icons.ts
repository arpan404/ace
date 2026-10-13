import type { AccountBadgeIcon } from "@ace/protocol/accounts";
import {
  BriefcaseIcon,
  CodeIcon,
  FlaskIcon,
  HeartIcon,
  HouseIcon,
  LightningIcon,
  MoonIcon,
  RocketIcon,
  StarIcon,
  WrenchIcon,
  type Icon,
} from "@phosphor-icons/react";

/** The curated account badge icons, in the order the badge picker offers them. */
export const accountBadgeIcons: readonly { icon: AccountBadgeIcon; label: string; glyph: Icon }[] =
  [
    { icon: "briefcase", label: "Briefcase", glyph: BriefcaseIcon },
    { icon: "house", label: "House", glyph: HouseIcon },
    { icon: "flask", label: "Flask", glyph: FlaskIcon },
    { icon: "rocket", label: "Rocket", glyph: RocketIcon },
    { icon: "moon", label: "Moon", glyph: MoonIcon },
    { icon: "wrench", label: "Wrench", glyph: WrenchIcon },
    { icon: "code", label: "Code", glyph: CodeIcon },
    { icon: "star", label: "Star", glyph: StarIcon },
    { icon: "heart", label: "Heart", glyph: HeartIcon },
    { icon: "lightning", label: "Lightning", glyph: LightningIcon },
  ];

/** Each badge icon's glyph, for drawing a stored badge. */
export const accountBadgeGlyphs = Object.fromEntries(
  accountBadgeIcons.map((entry) => [entry.icon, entry.glyph]),
) as Record<AccountBadgeIcon, Icon>;
