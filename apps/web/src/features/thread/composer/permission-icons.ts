import type { PermissionRisk } from "@ace/ui-core";
import {
  ShieldCheckIcon,
  HandPalmIcon,
  ShieldWarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/**
 * One glyph per risk, shared by the composer's approvals icon and its menu, so a provider's
 * native modes draw without a table of their own: a plain shield for the strict ones, a checked
 * shield for reviewed ones, a warning shield (in the attention colour) when nothing is gated.
 */
export const riskIcons: Record<PermissionRisk, PhosphorIcon> = {
  low: HandPalmIcon,
  medium: ShieldCheckIcon,
  high: ShieldWarningIcon,
};
