export const PANEL_SPRING_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 38,
  mass: 0.9,
} as const;

export const BOTTOM_PANEL_SPRING_TRANSITION = {
  height: {
    type: "spring",
    stiffness: 520,
    damping: 56,
    mass: 0.82,
    restDelta: 0.5,
  },
  opacity: { duration: 0.12, ease: [0.16, 1, 0.3, 1] },
} as const;
