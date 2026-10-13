import type { Scheme } from "./types.ts";

/*
 * Working, needs-you, done and failed are each theme's own (`sources/`), tuned to its surfaces
 * but always blue, amber, green and red. Waiting and not-responding have no per-theme value:
 * they are shared by every theme of a scheme, and their words are made readable per theme in
 * `css.ts`.
 */
export const sharedStatus: Record<Scheme, { waiting: string; unresponsive: string }> = {
  light: { waiting: "#7A5BD6", unresponsive: "#C2508A" },
  dark: { waiting: "#B49CF5", unresponsive: "#E88BB3" },
};
