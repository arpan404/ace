import { deferredMenuButton } from "./deferred-menu-button.tsx";

/** The sidebar's button paints with the shell; its closed menu loads while idle. */
export const SidebarMenu = deferredMenuButton(() =>
  import("./menu-button-popup.tsx").then((module) => module.SidebarMenuPopup),
);

/** The header keeps its ⋯ button eager, loading the menu only after paint or on a press. */
export const HeaderMenu = deferredMenuButton(() =>
  import("./menu-button-popup.tsx").then((module) => module.HeaderMenuPopup),
);
