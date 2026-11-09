import { forwardRef, useId, type SVGProps } from "react";
import { SidebarSimpleIcon, type IconProps } from "@phosphor-icons/react";
import {
  agentCursorOutline,
  agentCursorPath,
  agentCursorTip,
  aceToolScale,
  browserUseGlyph,
  computerUseGlyph,
  glyphStroke,
} from "@ace/design-tokens/glyphs";
import { cn } from "@/lib/cn.ts";
import { AceWings } from "./ace-mark.tsx";

/*
 * ace's own glyphs. They take Phosphor's props and weights (`regular` outlined, `fill` solid) so
 * they drop in wherever a Phosphor icon goes (`Icon`, settings pages, tab kinds), and they share
 * Phosphor regular's 1.5 stroke on a 24 box. The pointer in each is the agent cursor's shape.
 */

const stroke = glyphStroke;

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
  const { scale, tip } = computerUseGlyph.pointer;
  const solid = weight === "fill" || weight === "duotone";
  const ink = color ?? "currentColor";
  return (
    <svg ref={ref} {...frame(svg)}>
      <path
        d={agentCursorPath}
        transform={pointerTransform(scale, tip)}
        fill={solid ? ink : "none"}
        stroke={ink}
        strokeWidth={stroke / scale}
        strokeLinejoin="round"
      />
      <path d={computerUseGlyph.rays} stroke={ink} strokeWidth={stroke} strokeLinecap="round" />
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
  const { pointer: placement, globe, equator, knockout } = browserUseGlyph;
  const { scale } = placement;
  const pointer = pointerTransform(scale, placement.tip);
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
          strokeWidth={(stroke * knockout) / scale}
          strokeLinejoin="round"
        />
      </mask>
      <g mask={`url(#${mask})`} stroke={ink} strokeWidth={stroke} strokeLinecap="round">
        <circle cx={globe.cx} cy={globe.cy} r={globe.r} />
        <ellipse cx={globe.cx} cy={globe.cy} rx={globe.rx} ry={globe.r} />
        <path d={equator} />
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
      <g
        fill={color ?? "currentColor"}
        transform={`translate(${(12 * (1 - aceToolScale)).toFixed(2)} 3.06) scale(${aceToolScale})`}
      >
        <AceWings />
      </g>
    </svg>
  );
});

/**
 * Pause as two thin rounded bars: Phosphor's filled pause reads heavy at 14px, its outline busy.
 * Always solid, whatever the weight, so it pairs with `ResumeIcon`.
 */
export const PauseBarsIcon = forwardRef<SVGSVGElement, IconProps>(function PauseBarsIcon(
  { weight: _weight, color, ...svg },
  ref,
) {
  const ink = color ?? "currentColor";
  return (
    <svg ref={ref} {...frame(svg)}>
      <rect x="7.5" y="4.5" width="2" height="15" rx="1" fill={ink} />
      <rect x="14.5" y="4.5" width="2" height="15" rx="1" fill={ink} />
    </svg>
  );
});

/** Resume: a solid triangle with softened corners, the same height as `PauseBarsIcon`'s bars. */
export const ResumeIcon = forwardRef<SVGSVGElement, IconProps>(function ResumeIcon(
  { weight: _weight, color, ...svg },
  ref,
) {
  return (
    <svg ref={ref} {...frame(svg)}>
      <path
        d="M7.5 5.82v12.36a1.1 1.1 0 0 0 1.68.93l9.6-6.18a1.1 1.1 0 0 0 0-1.86l-9.6-6.18a1.1 1.1 0 0 0-1.68.93Z"
        fill={color ?? "currentColor"}
      />
    </svg>
  );
});

/**
 * The sidebar toggle while the sidebar shows: the same window glyph with its side pane filled in,
 * as the pane on screen is. Hidden, the toggle is the outline (`SidebarSimpleIcon`).
 */
export const SidebarShownIcon = forwardRef<SVGSVGElement, IconProps>(
  function SidebarShownIcon(props, ref) {
    return <SidebarSimpleIcon ref={ref} {...props} weight="fill" />;
  },
);
