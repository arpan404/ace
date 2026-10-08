import { lazy } from "react";

/**
 * The rail's ⋯ menu contents, loaded just after the first paint so More's icons and
 * wording stay out of the initial bundle (the menu and its trigger are there from the start).
 */
export const MoreMenuItems = lazy(() =>
  import("./more-menu-items.tsx").then((module) => ({ default: module.MoreMenuItems })),
);
