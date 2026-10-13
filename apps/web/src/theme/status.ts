import type { Scheme, StatusSet } from "./types.ts";

/**
 * Status colours, the same in every theme: one status vocabulary means green is always done and
 * blue always working, whatever the theme or accent.
 */
export const status: Record<Scheme, StatusSet> = {
  light: {
    working: "#2A62E3",
    workingText: "#2458CC",
    needs: "#C46A0B",
    needsText: "#9C520A",
    failed: "#D63B3B",
    failedText: "#B12B2B",
    done: "#2E8A50",
    doneText: "#23723F",
  },
  dark: {
    working: "#5C8DF0",
    workingText: "#86A9F5",
    needs: "#E9A14C",
    needsText: "#EFB46B",
    failed: "#EE7272",
    failedText: "#F29090",
    done: "#4DBE78",
    doneText: "#73CC94",
  },
};

/** Waiting and not-responding hues: shared by every theme of a scheme. */
export const sharedStatus: Record<Scheme, { waiting: string; unresponsive: string }> = {
  light: { waiting: "#7A5BD6", unresponsive: "#C2508A" },
  dark: { waiting: "#B49CF5", unresponsive: "#E88BB3" },
};
