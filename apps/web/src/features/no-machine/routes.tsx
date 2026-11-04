import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  NoMachineFleetScreen,
  NoMachineProfileScreen,
  NoMachineSettingsNav,
} from "@/features/settings/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
import { NoMachineShell } from "./no-machine-shell.tsx";
import { NoMachineThreads } from "./threads-empty.tsx";

function SettingsFrame(props: { children: ReactNode }) {
  return (
    <ViewFrame label="Settings" sidebar={<NoMachineSettingsNav />} place="sidebar">
      {props.children}
    </ViewFrame>
  );
}

const root = createRootRoute({ component: NoMachineShell });
const threads = createRoute({ getParentRoute: () => root, path: "/", component: NoMachineThreads });
const settings = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: () => (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  ),
});
const settingsIndex = createRoute({
  getParentRoute: () => settings,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/remote", replace: true });
  },
});
const profile = createRoute({
  getParentRoute: () => settings,
  path: "/profile",
  component: NoMachineProfileScreen,
});
const fleet = createRoute({
  getParentRoute: () => settings,
  path: "/remote",
  component: () => <NoMachineFleetScreen />,
});
// A pairing address typed or opened with no machine: Fleet, on the pairing form.
const pair = createRoute({
  getParentRoute: () => root,
  path: "/pair",
  component: () => (
    <SettingsFrame>
      <NoMachineFleetScreen pairing />
    </SettingsFrame>
  ),
});

const routeTree = root.addChildren([
  threads,
  settings.addChildren([settingsIndex, profile, fleet]),
  pair,
]);

/**
 * The app's places with no machine. Any other address (a thread, a machine's settings page)
 * lands on Threads, which says to add a machine.
 */
export function createNoMachineRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    defaultNotFoundComponent: NoMachineThreads,
  });
}
