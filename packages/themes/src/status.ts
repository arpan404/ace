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

/** A thread row's status icon colour (`RowStatusTone` in `@ace/ui-core`), minus the muted inks. */
export type RowStatusColour =
  | "needs-you"
  | "failed"
  | "working"
  | "waiting"
  | "background"
  | "finished";

/**
 * Thread-row status icons, one colour per state, the same in every theme of a scheme (DESIGN.md
 * thread row). Each is a mark (an icon, no words), so it needs 3:1 against the sidebar's
 * surfaces, hover and the open row's fill. The web draws them as `--row-status-*`; the iPhone's
 * theme generator emits them as `AceTheme.RowStatus`.
 */
export const rowStatusColours: Record<Scheme, Record<RowStatusColour, string>> = {
  dark: {
    "needs-you": "#EDB250",
    failed: "#F47670",
    working: "#7E9FD6",
    waiting: "#A08FD4",
    background: "#7E8692",
    finished: "#6CBF8C",
  },
  light: {
    "needs-you": "#AD7200",
    failed: "#C93A33",
    working: "#3D63A6",
    waiting: "#6A55A8",
    background: "#6B7380",
    finished: "#2E7D4F",
  },
};
