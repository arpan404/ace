import type { Ripple } from "./use-local-echo.ts";

/**
 * Taps and clicks over the live page, drawn the moment they land: a ring that grows and fades
 * at the point, gone once its animation ends. It never takes input.
 */
export function LocalEchoOverlay(props: {
  ripples: readonly Ripple[];
  onSettled(id: number): void;
}) {
  return props.ripples.map((ripple) => (
    <span
      key={ripple.id}
      aria-hidden
      data-tap-ripple=""
      style={{ left: ripple.x, top: ripple.y }}
      onAnimationEnd={() => props.onSettled(ripple.id)}
      className="fx-tap-ripple pointer-events-none absolute -mt-5 -ml-5 size-10 rounded-full bg-foreground/15"
    />
  ));
}
