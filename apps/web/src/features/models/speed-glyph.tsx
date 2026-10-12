import type { Speed } from "@ace/ui-core";
import { GaugeIcon, LightningIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/**
 * A speed as an icon: a gauge for standard, one bolt for fast, two overlapping bolts for
 * ultrafast. Decorative; whatever shows it names the speed.
 */
export function SpeedGlyph(props: { speed: Speed; size: number; className?: string | undefined }) {
  const { speed, size } = props;
  if (speed === "standard")
    return <GaugeIcon aria-hidden size={size} className={cn("shrink-0", props.className)} />;
  if (speed === "fast")
    return <LightningIcon aria-hidden size={size} className={cn("shrink-0", props.className)} />;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0", props.className)}>
      <LightningIcon size={size} />
      <LightningIcon size={size} style={{ marginLeft: -size * 0.45 }} />
    </span>
  );
}
