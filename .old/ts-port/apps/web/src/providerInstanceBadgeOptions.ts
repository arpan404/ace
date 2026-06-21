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
