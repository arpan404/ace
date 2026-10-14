import type { AccessMode } from "@ace/protocol";
import {
  EyeIcon,
  HandPalmIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldWarningIcon,
  SlidersHorizontalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/** One glyph per access mode, shared by the composer chip and its menu. */
export const accessIcons: Record<AccessMode, PhosphorIcon> = {
  "read-only": EyeIcon,
  ask: HandPalmIcon,
  "auto-review": ShieldCheckIcon,
  "full-access": ShieldWarningIcon,
};
/** A provider-native override from Settings, or the agent's own default. */
export const customIcon: PhosphorIcon = SlidersHorizontalIcon;
export const agentDefaultIcon: PhosphorIcon = ShieldIcon;
