import { lazy, Suspense } from "react";
import { loadComputerUseSettings } from "@/features/computer-use/index.ts";
import { AdvancedSettings } from "./advanced-page.tsx";
import { AppearanceSettings } from "./appearance-page.tsx";
import { GeneralSettings } from "./general-page.tsx";
import { KeyboardShortcuts } from "./keyboard-page.tsx";
import { NotificationSettings } from "./notifications-page.tsx";
import { Navigate } from "@tanstack/react-router";
import { usePhone } from "@/lib/breakpoints.ts";
import { Screen } from "@/features/shell/index.ts";
import { RemoteDevices } from "./remote-page.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { SettingsBody } from "./settings-body.tsx";
import { SettingsPageLinks } from "./settings-nav.tsx";

/* One screen per Settings page: its title, lede and actions around the page body. */

export function GeneralSettingsScreen() {
  return (
    <SettingsBody page="General">
      <GeneralSettings />
    </SettingsBody>
  );
}

export function AppearanceSettingsScreen() {
  return (
    <SettingsBody page="Appearance">
      <AppearanceSettings />
    </SettingsBody>
  );
}

/** The Providers page loads on its own, with sign-in and readiness, apart from the others. */
const ProviderSettings = lazy(() =>
  import("./providers-page.tsx").then((module) => ({ default: module.ProviderSettings })),
);
/** A provider's own page, likewise. */
const ProviderDetail = lazy(() =>
  import("./provider-detail.tsx").then((module) => ({ default: module.ProviderDetail })),
);

export function ProviderSettingsScreen() {
  return (
    <SettingsBody
      page="Providers"
      lede="The coding agents on this computer. ace runs each one with its own sign-in."
    >
      <Suspense
        fallback={<ListSkeleton label="provider CLIs" shape="row" rows={5} className="mt-7" />}
      >
        <ProviderSettings />
      </Suspense>
    </SettingsBody>
  );
}

/** `/settings/providers/$provider`: one provider's page (`acp:<name>` for an ACP agent). */
export function ProviderDetailScreen(props: { id: string }) {
  return (
    <Suspense
      fallback={
        <SettingsBody page="Providers">
          <ListSkeleton label="provider" shape="row" rows={4} className="mt-7" />
        </SettingsBody>
      }
    >
      <ProviderDetail id={props.id} />
    </Suspense>
  );
}

export function RemoteSettingsScreen() {
  return (
    <SettingsBody
      page="Remote devices"
      lede="Machines running the ace daemon that this app can see. Threads from every machine merge into one list."
    >
      <RemoteDevices />
    </SettingsBody>
  );
}

export function NotificationSettingsScreen() {
  return (
    <SettingsBody page="Notifications">
      <NotificationSettings />
    </SettingsBody>
  );
}

export function KeyboardSettingsScreen() {
  return (
    <SettingsBody
      page="Keyboard"
      lede="Click a shortcut and press the new keys. Changes apply at once on every device using this daemon."
    >
      <KeyboardShortcuts />
    </SettingsBody>
  );
}

export function AdvancedSettingsScreen() {
  return (
    <SettingsBody page="Advanced">
      <AdvancedSettings />
    </SettingsBody>
  );
}

const ComputerUseSettings = lazy(loadComputerUseSettings);

export function ComputerUseSettingsScreen() {
  return (
    <SettingsBody
      page="Computer use"
      lede="Agents can use apps on this Mac in the background while you keep working. You approve each app, can take over at any time and can stop everything at once."
    >
      <Suspense fallback={null}>
        <ComputerUseSettings />
      </Suspense>
    </SettingsBody>
  );
}

/**
 * `/settings`: on a phone, the list of pages (the sidebar is a sheet there, so this is the way
 * in); wider, General.
 */
export function SettingsIndexScreen() {
  const phone = usePhone();
  if (!phone) return <Navigate to="/settings/general" replace />;
  return (
    <Screen title="Settings">
      <nav aria-label="Settings" className="h-full overflow-auto px-2 pt-4 pb-20">
        <SettingsPageLinks />
      </nav>
    </Screen>
  );
}
