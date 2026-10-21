import { Navigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { loadComputerUseSettings } from "@/features/computer-use/index.ts";
import { PastSessionsSettings } from "@/features/history/index.ts";
const AdvancedSettings = lazy(() =>
  import("./advanced-page.tsx").then((module) => ({ default: module.AdvancedSettings })),
);
import { AppearanceSettings } from "./appearance-page.tsx";
import { KeyboardShortcuts } from "./keyboard-page.tsx";
import { NotificationSettings } from "./notifications-page.tsx";
import { ViewListPage } from "@/features/shell/index.ts";
const RemoteDevices = lazy(() =>
  import("./remote-page.tsx").then((module) => ({ default: module.RemoteDevices })),
);
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { settingRow } from "./settings-index.ts";
import { Skeleton, ListSkeleton } from "@/components/ui/skeleton.tsx";
import { RediscoverButton } from "./rediscover-button.tsx";
import { SettingsBody } from "./settings-body.tsx";
import { useSettingsMachine } from "./machine-scope.tsx";

/* One screen per Settings page: its title, lede and actions around the page body. */

const GeneralSettings = lazy(() =>
  import("./general-page.tsx").then((module) => ({ default: module.GeneralSettings })),
);

export function GeneralSettingsScreen() {
  return (
    <SettingsBody page="General">
      <Suspense fallback={null}>
        <GeneralSettings />
      </Suspense>
    </SettingsBody>
  );
}

const AgentsSettings = lazy(() =>
  import("./agents-page.tsx").then((module) => ({ default: module.AgentsSettings })),
);

export function AgentsSettingsScreen() {
  return (
    <SettingsBody page="Agents">
      <Suspense fallback={<AgentsPlaceholder />}>
        <AgentsSettings />
      </Suspense>
    </SettingsBody>
  );
}

const OverviewSettings = lazy(() =>
  import("./overview-page.tsx").then((module) => ({ default: module.OverviewSettings })),
);

export function OverviewSettingsScreen() {
  return (
    <SettingsBody page="Overview">
      <Suspense fallback={<ListSkeleton label="machines" shape="row" rows={3} className="mt-10" />}>
        <OverviewSettings />
      </Suspense>
    </SettingsBody>
  );
}

function AgentsPlaceholder() {
  return (
    <SettingSection label="New threads">
      {(["providers.default", "access.defaultMode", "threads.useWorktree"] as const).map(
        (entry) => (
          <SettingRow key={entry} {...settingRow(entry)}>
            <Skeleton className="h-7 w-28 rounded-md" />
          </SettingRow>
        ),
      )}
    </SettingSection>
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
    <SettingsBody page="Providers" titleActions={<RediscoverButton />}>
      <Suspense
        fallback={<ListSkeleton label="provider CLIs" shape="row" rows={5} className="mt-10" />}
      >
        <ProviderSettings />
      </Suspense>
      <PastSessionsSettings />
    </SettingsBody>
  );
}

/** `/settings/providers/$provider`: one provider's page (`acp:<name>` for an ACP agent). */
export function ProviderDetailScreen(props: { id: string }) {
  return (
    <Suspense
      fallback={
        <SettingsBody page="Providers">
          <ListSkeleton label="provider" shape="row" rows={4} className="mt-10" />
        </SettingsBody>
      }
    >
      <ProviderDetail id={props.id} />
    </Suspense>
  );
}

export function RemoteSettingsScreen() {
  return (
    <SettingsBody page="Machines and devices">
      <Suspense fallback={<ListSkeleton label="remote settings" shape="row" rows={4} />}>
        <RemoteDevices />
      </Suspense>
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
    <SettingsBody page="Keyboard">
      <KeyboardShortcuts />
    </SettingsBody>
  );
}

export function AdvancedSettingsScreen() {
  return (
    <SettingsBody page="Advanced">
      <Suspense fallback={<ListSkeleton label="diagnostics" shape="row" rows={3} />}>
        <AdvancedSettings />
      </Suspense>
    </SettingsBody>
  );
}

const ComputerUseSettings = lazy(loadComputerUseSettings);

export function ComputerUseSettingsScreen() {
  const { machine } = useSettingsMachine();
  return (
    <SettingsBody page="Computer use">
      <Suspense fallback={null}>
        <ComputerUseSettings
          remoteMachine={machine && !machine.primary ? machine.name : undefined}
        />
      </Suspense>
    </SettingsBody>
  );
}

/**
 * `/settings`: on a narrow window, where the sidebar is a sheet, the page list is the page (and
 * leaves the sheet to the threads); wider, Overview.
 */
export function SettingsIndexScreen() {
  return <ViewListPage title="Settings" fallback={<Navigate to="/settings/overview" replace />} />;
}

const Prompts = lazy(() =>
  import("./prompts-page.tsx").then((module) => ({ default: module.PromptsSettingsScreen })),
);
export function PromptsSettingsScreen() {
  return (
    <Suspense fallback={null}>
      <Prompts />
    </Suspense>
  );
}

const PairDevicePage = lazy(() =>
  import("./pair-device.tsx").then((module) => ({ default: module.PairDevicePage })),
);
export function PairDeviceScreen() {
  return (
    <Suspense fallback={<SettingsBody page="Pair a device" />}>
      <PairDevicePage />
    </Suspense>
  );
}

const SourceControlSettings = lazy(() =>
  import("./source-control-page.tsx").then((module) => ({ default: module.SourceControlSettings })),
);
export function SourceControlSettingsScreen() {
  return (
    <SettingsBody
      page="Source control"
      lede="GitHub through this machine's gh CLI. Credentials stay with gh and Git."
    >
      <Suspense fallback={null}>
        <SourceControlSettings />
      </Suspense>
    </SettingsBody>
  );
}

const StorageSettings = lazy(() =>
  import("./storage-page.tsx").then((module) => ({ default: module.StorageSettings })),
);
const BrowserSettings = lazy(() =>
  import("./browser-page.tsx").then((module) => ({ default: module.BrowserSettings })),
);

export function BrowserSettingsScreen() {
  return (
    <SettingsBody page="Browser">
      <Suspense fallback={null}>
        <BrowserSettings />
      </Suspense>
    </SettingsBody>
  );
}

export function StorageSettingsScreen() {
  return (
    <SettingsBody page="Storage">
      <Suspense fallback={<ListSkeleton label="storage" shape="row" rows={6} />}>
        <StorageSettings />
      </Suspense>
    </SettingsBody>
  );
}
