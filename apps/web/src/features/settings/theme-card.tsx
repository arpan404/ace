import { cn } from "@/lib/cn.ts";
import type { CSSProperties } from "react";
import type { Theme } from "@/theme/presets.ts";

function previewStyle(theme: Theme): CSSProperties {
  const t = theme.tokens;
  return {
    background: `radial-gradient(60% 60% at 10% 10%, ${t["--w1"]}, transparent 70%), radial-gradient(50% 50% at 90% 90%, ${t["--w2"]}, transparent 70%), ${t["--wall"]}`,
  };
}

/** A miniature window (rail, sidebar, reading column) drawn from the theme's own tokens. */
function Miniature(props: { theme: Theme; className?: string }) {
  const t = props.theme.tokens;
  return (
    <div className={cn("absolute inset-0", props.className)} style={previewStyle(props.theme)}>
      <div
        className="absolute inset-x-3.5 top-3.5 bottom-0 grid grid-cols-[18px_42px_1fr] overflow-hidden rounded-t-md"
        style={{ boxShadow: `0 0 0 0.5px ${t["--border"]}` }}
      >
        <i style={{ background: `rgb(${t["--rail-rgb"]} / 0.85)` }} />
        <i style={{ background: `rgb(${t["--sidebar-rgb"]} / 0.85)` }} />
        <i style={{ background: `rgb(${t["--reading-rgb"]} / 0.92)` }} />
      </div>
    </div>
  );
}

/** One choice in the theme grid. "System" shows Light and Dark split diagonally. */
export function ThemeCard(props: {
  name: string;
  selected: boolean;
  theme?: Theme;
  system?: { light: Theme; dark: Theme };
  custom?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onSelect}
      className="group min-w-0 cursor-pointer text-center outline-none"
    >
      <span
        className={cn(
          "relative block h-24 overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--border)] transition-shadow duration-(--dur-2)",
          props.selected &&
            "shadow-[0_0_0_2px_var(--ring),0_0_0_5px_color-mix(in_oklab,var(--ring)_18%,transparent)]",
          "group-focus-visible:shadow-[0_0_0_2px_var(--ring)]",
        )}
      >
        {props.theme && <Miniature theme={props.theme} />}
        {props.system && (
          <>
            <Miniature theme={props.system.light} />
            <Miniature
              theme={props.system.dark}
              className="[clip-path:polygon(60%_0,100%_0,100%_100%,40%_100%)]"
            />
          </>
        )}
      </span>
      <span
        className={cn(
          "mt-2 block text-sm text-muted-foreground",
          props.selected && "font-medium text-foreground",
        )}
      >
        {props.name}
        {props.custom && (
          <span className="ml-1.5 rounded-sm bg-secondary px-1.5 text-[10px] font-medium text-muted-foreground">
            custom
          </span>
        )}
      </span>
    </button>
  );
}
