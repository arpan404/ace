import {
  BriefcaseIcon,
  Building2Icon,
  CircleIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  type LucideIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";

import { cn } from "./lib/utils";

export type ProviderInstanceBadgeColor =
  | "slate"
  | "blue"
  | "emerald"
  | "amber"
  | "rose"
  | "violet"
  | "cyan";
export type ProviderInstanceBadgeIcon =
  | "circle"
  | "briefcase"
  | "user"
  | "building"
  | "key"
  | "spark"
  | "lab";

export const PROVIDER_INSTANCE_BADGE_COLORS: ReadonlyArray<{
  hex: string;
  label: string;
  value: ProviderInstanceBadgeColor;
}> = [
  { value: "slate", label: "Slate", hex: "#64748b" },
  { value: "blue", label: "Blue", hex: "#2563eb" },
  { value: "emerald", label: "Emerald", hex: "#059669" },
  { value: "amber", label: "Amber", hex: "#d97706" },
  { value: "rose", label: "Rose", hex: "#e11d48" },
  { value: "violet", label: "Violet", hex: "#7c3aed" },
  { value: "cyan", label: "Cyan", hex: "#0891b2" },
] as const;

export const PROVIDER_INSTANCE_BADGE_ICONS: ReadonlyArray<{
  Icon: LucideIcon;
  label: string;
  value: ProviderInstanceBadgeIcon;
}> = [
  { value: "circle", label: "Circle", Icon: CircleIcon },
  { value: "briefcase", label: "Work", Icon: BriefcaseIcon },
  { value: "user", label: "Personal", Icon: UserIcon },
  { value: "building", label: "Org", Icon: Building2Icon },
  { value: "key", label: "Key", Icon: KeyRoundIcon },
  { value: "spark", label: "Spark", Icon: SparklesIcon },
  { value: "lab", label: "Lab", Icon: FlaskConicalIcon },
] as const;

const DEFAULT_BADGE_COLOR: ProviderInstanceBadgeColor = "slate";
const DEFAULT_BADGE_COLOR_HEX = "#64748b";
const DEFAULT_BADGE_ICON: ProviderInstanceBadgeIcon = "circle";

export function normalizeProviderInstanceBadgeColor(
  value: string | undefined,
): ProviderInstanceBadgeColor {
  return PROVIDER_INSTANCE_BADGE_COLORS.some((color) => color.value === value)
    ? (value as ProviderInstanceBadgeColor)
    : DEFAULT_BADGE_COLOR;
}

export function normalizeProviderInstanceBadgeIcon(
  value: string | undefined,
): ProviderInstanceBadgeIcon {
  return PROVIDER_INSTANCE_BADGE_ICONS.some((icon) => icon.value === value)
    ? (value as ProviderInstanceBadgeIcon)
    : DEFAULT_BADGE_ICON;
}

export function getProviderInstanceBadgeColorHex(value: string | undefined): string {
  const normalized = normalizeProviderInstanceBadgeColor(value);
  return (
    PROVIDER_INSTANCE_BADGE_COLORS.find((color) => color.value === normalized)?.hex ??
    DEFAULT_BADGE_COLOR_HEX
  );
}

export function ProviderInstanceBadgeIconGlyph({
  icon,
  className,
}: {
  icon?: string | undefined;
  className?: string | undefined;
}) {
  const normalized = normalizeProviderInstanceBadgeIcon(icon);
  const Icon = PROVIDER_INSTANCE_BADGE_ICONS.find((entry) => entry.value === normalized)?.Icon;
  return Icon ? <Icon aria-hidden="true" className={className} /> : null;
}

export function ProviderInstanceBadge({
  color,
  icon,
  className,
}: {
  color?: string | undefined;
  icon?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-provider-instance-badge="true"
      className={cn(
        "inline-flex size-3.5 items-center justify-center rounded-full border border-background text-white shadow-[0_0_0_1px_hsl(var(--border))]",
        className,
      )}
      style={{ backgroundColor: getProviderInstanceBadgeColorHex(color) }}
    >
      <ProviderInstanceBadgeIconGlyph icon={icon} className="size-2.5" />
    </span>
  );
}
