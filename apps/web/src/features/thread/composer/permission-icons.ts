import type { AccessMode } from "@ace/protocol";
import {
  EyeIcon,
  HandPalmIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldWarningIcon,
  SlidersHorizontalIcon,
  type Icon as GlyphIcon,
} from "@ace/icons";

/** One glyph per access mode, shared by the composer chip and its menu. */
export const accessIcons: Record<AccessMode, GlyphIcon> = {
  "read-only": EyeIcon,
  ask: HandPalmIcon,
  "auto-review": ShieldCheckIcon,
  "full-access": ShieldWarningIcon,
};
/** A provider-native override from Settings, or the agent's own default. */
export const customIcon: GlyphIcon = SlidersHorizontalIcon;
export const agentDefaultIcon: GlyphIcon = ShieldIcon;
