import type { PermissionMode } from "@ace/protocol";
import {
  EyeIcon,
  HandPalmIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/** One glyph per approval mode, shared by the composer's chip and its menu. */
export const permissionIcons: Record<PermissionMode, PhosphorIcon> = {
  "read-only": EyeIcon,
  ask: HandPalmIcon,
  "auto-review": ShieldCheckIcon,
  "full-access": ShieldWarningIcon,
};
