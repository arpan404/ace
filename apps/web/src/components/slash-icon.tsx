import { forwardRef } from "react";
import type { IconProps } from "@phosphor-icons/react";

/** Commands use their literal trigger, at the same size as the other row glyphs. */
export const SlashIcon = forwardRef<SVGSVGElement, IconProps>(function SlashIcon(
  { size = 16, weight: _weight, mirrored: _mirrored, ...props },
  ref,
) {
  return (
    <svg ref={ref} width={size} height={size} viewBox="0 0 16 16" {...props}>
      <path d="M11 2 5 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
});
