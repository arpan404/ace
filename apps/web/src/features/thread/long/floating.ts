/**
 * The surface of every control floating over the transcript (Jump to live, the jump bar, a
 * failed jump): a 32px pill on the floating material (`.ace-floating`: glass under Translucent,
 * solid under Solid), with the rim, edge and floating shadow. The glass tint keeps its label at
 * AA over any text or code moving under it.
 */
export const floatingControl =
  "ace-floating inline-flex h-8 items-center gap-1.5 rounded-full text-ui text-popover-foreground";

/** Hovering a floating control rings its edge and fills it with the next surface, opaque in either mode. */
export const floatingHover =
  "hover:bg-surface-1 hover:[--float-edge:var(--ring)] hover:[--glass-edge:var(--ring)]";

/** Its motion: in on the spring, out quicker; fades only when motion is reduced. */
export const floatingMotion = (phase: "enter" | "exit") =>
  phase === "enter" ? "fx-float-in" : "fx-float-out";
