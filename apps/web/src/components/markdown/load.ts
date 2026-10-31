/**
 * The markit renderer's code, split so agent prose waits for it, and opening a
 * thread starts it early.
 */
export const loadMarkitProse = () => import("./markit-prose.tsx");
