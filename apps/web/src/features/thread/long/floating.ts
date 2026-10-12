/**
 * The surface of every control floating over the transcript (Jump to live, the jump bar, a
 * failed jump): a 32px pill on the floating material (`.ace-floating`: glass under Translucent,
 * solid under Solid), outlined by its 1px edge ring and lifted by the floating shadow.
 */
export const floatingControl =
  "ace-floating inline-flex h-8 items-center gap-1.5 rounded-full text-ui text-popover-foreground";

/** Hovering a floating control brightens its edge and tints its surface, opaque in either mode. */
export const floatingHover =
  "hover:bg-[color-mix(in_oklab,var(--surface-2),var(--foreground)_7%)] hover:[--float-edge:color-mix(in_oklab,var(--ring)_60%,transparent)] hover:[--glass-edge:color-mix(in_oklab,var(--ring)_60%,transparent)]";

/** Its motion: in on the spring, out quicker; fades only when motion is reduced. */
export const floatingMotion = (phase: "enter" | "exit") =>
  phase === "enter" ? "fx-float-in" : "fx-float-out";
