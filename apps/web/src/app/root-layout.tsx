import { Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "./app-shell.tsx";

/** Routes drawn without the app's frame: the desktop's menu-bar popover, in its own window. */
const bare = new Set(["/tray"]);

/**
 * The root's view: the app's frame around every route, except a window that is only a
 * popover. Such a window never navigates to the app's routes, so the choice holds for its life.
 */
export function RootLayout() {
  const frameless = useRouterState({ select: (state) => bare.has(state.location.pathname) });
  return frameless ? <Outlet /> : <AppShell />;
}
