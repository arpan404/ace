import { cn } from "./lib/utils";
import {
  PROVIDER_INSTANCE_BADGE_ICONS,
  type ProviderInstanceBadgeColor,
  normalizeProviderInstanceBadgeColor,
  normalizeProviderInstanceBadgeIcon,
} from "./providerInstanceBadgeOptions";

const BADGE_COLOR_BG_CLASS: Record<ProviderInstanceBadgeColor, string> = {
  slate: "bg-slate-500",
  blue: "bg-blue-600",
  emerald: "bg-emerald-600",
  amber: "bg-amber-600",
  rose: "bg-rose-600",
  violet: "bg-violet-600",
  cyan: "bg-cyan-600",
};

const DEFAULT_BADGE_COLOR: ProviderInstanceBadgeColor = "slate";
function getProviderInstanceBadgeColorClass(value: string | undefined): string {
  const normalized = normalizeProviderInstanceBadgeColor(value);
  return BADGE_COLOR_BG_CLASS[normalized] ?? BADGE_COLOR_BG_CLASS[DEFAULT_BADGE_COLOR];
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
        "inline-flex size-4 items-center justify-center rounded-full border border-background p-[2px] text-white shadow-[0_0_0_1px_var(--border)]",
        getProviderInstanceBadgeColorClass(color),
        className,
      )}
    >
      <ProviderInstanceBadgeIconGlyph icon={icon} className="size-full" />
    </span>
  );
}
