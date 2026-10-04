import type { ProviderKind } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { ProviderGlyph } from "./provider-glyph.tsx";

/**
 * A provider's icon for pickers and menus. Placeholder until the provider icon set lands: it
 * draws the monochrome glyph at icon size, and keeps this import path stable for callers.
 */
export function ProviderIcon(props: {
  provider: ProviderKind;
  /** Pixel size; 16 by default. */
  size?: 12 | 14 | 16;
  label?: string;
  className?: string;
}) {
  const size = props.size ?? 16;
  return (
    <ProviderGlyph
      provider={props.provider}
      {...(props.label ? { label: props.label } : {})}
      className={cn(size === 12 ? "size-3" : size === 14 ? "size-3.5" : "size-4", props.className)}
    />
  );
}
