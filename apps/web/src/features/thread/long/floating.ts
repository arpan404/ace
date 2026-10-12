/**
 * The surface of every control floating over the transcript (Jump to live, the jump bar, a
 * failed jump): a 32px pill with a 1px border token and a soft shadow on an opaque popover
 * surface. It sits over moving text and code, so it is never see-through glass: it has to
 * read as a button whatever scrolls behind it.
 */
export const floatingControl =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-input bg-popover text-ui text-popover-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_20px_-8px_rgb(0_0_0/0.28)]";

/** Its motion: in on the spring, out quicker; fade only when motion is reduced. */
export const floatingMotion = (phase: "enter" | "exit") =>
  phase === "enter" ? "fx-float-in" : "fx-float-out";
