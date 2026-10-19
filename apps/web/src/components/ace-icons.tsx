import { forwardRef, useId, type SVGProps } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { agentCursorOutline, agentCursorPath, agentCursorTip } from "@ace/design-tokens/glyphs";
import { cn } from "@/lib/cn.ts";
import { AceWings } from "./ace-mark.tsx";

/*
 * ace's own glyphs. They take Phosphor's props and weights (`regular` outlined, `fill` solid) so
 * they drop in wherever a Phosphor icon goes (`Icon`, settings pages, tab kinds), and they share
 * Phosphor regular's 1.5 stroke on a 24 box. The pointer in each is the agent cursor's shape.
 */

const stroke = 1.5;

/** The cursor's path scaled by `scale`, with its tip moved to `tip`. */
function pointerTransform(scale: number, tip: { x: number; y: number }): string {
  const x = tip.x - agentCursorTip.x * scale;
  const y = tip.y - agentCursorTip.y * scale;
  return `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale})`;
}

/** The 24-box `<svg>` attributes every glyph shares, from Phosphor's size and mirroring props. */
function frame(props: Omit<IconProps, "weight" | "color">): SVGProps<SVGSVGElement> {
  const { size = 16, mirrored, style, ...rest } = props;
  return {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    style: mirrored ? { ...style, transform: "scaleX(-1)" } : style,
    ...rest,
  };
}

/**
 * Computer use: the agent's pointer with three short rays at its tip, an agent acting in apps.
 * No window or monitor box: the pointer is the whole idea.
 */
export const ComputerUseIcon = forwardRef<SVGSVGElement, IconProps>(function ComputerUseIcon(
  { weight = "regular", color, ...svg },
  ref,
) {
  const scale = 0.8;
  const solid = weight === "fill" || weight === "duotone";
  const ink = color ?? "currentColor";
  return (
    <svg ref={ref} {...frame(svg)}>
      <path
        d={agentCursorPath}
        transform={pointerTransform(scale, { x: 9, y: 9 })}
        fill={solid ? ink : "none"}
        stroke={ink}
        strokeWidth={stroke / scale}
        strokeLinejoin="round"
      />
      <path
        d="M9 2.75v2M2.75 9h2M4.6 4.6l1.4 1.4"
        stroke={ink}
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </svg>
  );
});

/**
 * Browser use: a globe with the agent's pointer resting on its lower right. The globe is cut
 * away around the pointer so the two read apart at 14 px.
 */
export const BrowserUseIcon = forwardRef<SVGSVGElement, IconProps>(function BrowserUseIcon(
  { weight = "regular", color, ...svg },
  ref,
) {
  const mask = `ace-browser-use-${useId()}`;
  const scale = 0.62;
  const pointer = pointerTransform(scale, { x: 12.6, y: 12.6 });
  const solid = weight === "fill" || weight === "duotone";
  const ink = color ?? "currentColor";
  return (
    <svg ref={ref} {...frame(svg)}>
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" />
        <path
          d={agentCursorPath}
          transform={pointer}
          fill="black"
          stroke="black"
          strokeWidth={(stroke * 3) / scale}
          strokeLinejoin="round"
        />
      </mask>
      <g mask={`url(#${mask})`} stroke={ink} strokeWidth={stroke} strokeLinecap="round">
        <circle cx="10.5" cy="10.5" r="7.5" />
        <ellipse cx="10.5" cy="10.5" rx="3.25" ry="7.5" />
        <path d="M3 10.5h15" />
      </g>
      <path
        d={agentCursorPath}
        transform={pointer}
        fill={solid ? ink : "none"}
        stroke={ink}
        strokeWidth={stroke / scale}
        strokeLinejoin="round"
      />
    </svg>
  );
});

/**
 * The agent cursor as it appears over pages ("Pebble"): the person's accent (`--ring`) with an
 * outline in the colour that reads on that accent (`--ring-foreground`: white on most accents,
 * dark on a pale one) and a soft shadow, so it holds up in every theme and mode.
 */
export const AgentCursorIcon = forwardRef<SVGSVGElement, IconProps>(function AgentCursorIcon(
  { weight: _weight, color, className, ...svg },
  ref,
) {
  return (
    <svg ref={ref} {...frame({ ...svg, className: cn("drop-shadow-sm", className) })}>
      <path
        d={agentCursorPath}
        fill={color ?? "var(--ring)"}
        stroke="var(--ring-foreground)"
        strokeWidth={agentCursorOutline}
        strokeLinejoin="round"
      />
    </svg>
  );
});

/**
 * ace's own tools: the ace mark, solid at every weight, a little inside the 24 box so its filled
 * wings sit level with Phosphor's outlined glyphs in a row of steps.
 */
export const AceToolIcon = forwardRef<SVGSVGElement, IconProps>(function AceToolIcon(
  { weight: _weight, color, ...svg },
  ref,
) {
  return (
    <svg ref={ref} {...frame(svg)}>
      <g fill={color ?? "currentColor"} transform="translate(2.16 3.06) scale(0.82)">
        <AceWings />
      </g>
    </svg>
  );
});
