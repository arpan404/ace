import { lazy, Suspense, type ComponentType } from "react";
import type { ProjectId } from "@ace/contracts";

import { Skeleton } from "../ui/skeleton";
import { SettingsPageContainer, SettingsSection } from "./SettingsPanelPrimitives";

const SETTINGS_PANEL_LOADING_ROW_KEYS = [
  "general",
  "chat",
  "browser",
  "editor",
  "advanced",
] as const;

function SettingsPanelLoadingState() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Loading">
        <div className="space-y-1">
          {SETTINGS_PANEL_LOADING_ROW_KEYS.map((rowKey) => (
            <div
              key={rowKey}
              className="grid gap-2 rounded-[var(--control-radius)] px-3 py-3 sm:px-4 md:grid-cols-[minmax(0,1fr)_10rem] md:items-center md:gap-4"
            >
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-3.5 w-40 max-w-full" />
                <Skeleton className="h-3 w-full max-w-xl" />
              </div>
              <Skeleton className="h-7 w-full md:w-40" />
            </div>
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function LazySettingsRoute<Props extends object>({
  panel: Panel,
  props,
}: {
  panel: ComponentType<Props>;
  props: Props;
}) {
  return (
    <Suspense fallback={<SettingsPanelLoadingState />}>
      <Panel {...props} />
    </Suspense>
  );
}

function createLazySettingsPanel<Props extends object = object>(
  loader: () => Promise<{ default: ComponentType<any> }>,
) {
  const Panel = lazy(loader) as ComponentType<Props>;

  return function LazySettingsPanelRoute(props: Props) {
    return <LazySettingsRoute panel={Panel} props={props} />;
  };
}

export const AboutSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.AboutSettingsPanel })),
);

export const AdvancedSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.AdvancedSettingsPanel })),
);

export const ArchivedThreadsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ArchivedThreadsPanel })),
);

export const BrowserSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.BrowserSettingsPanel })),
);

export const ChatSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ChatSettingsPanel })),
);

export const DevicesSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./DevicesSettingsPanel").then((module) => ({ default: module.DevicesSettingsPanel })),
);

export const EditorSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.EditorSettingsPanel })),
);

export const EnvironmentSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.EnvironmentSettingsPanel })),
);

export const ProjectEnvironmentSettingsPanelRoute = createLazySettingsPanel<{
  readonly projectId: ProjectId;
}>(() =>
  import("./SettingsPanels").then((module) => ({
    default: module.ProjectEnvironmentSettingsPanel,
  })),
);

export const GeneralSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.GeneralSettingsPanel })),
);

export const ProvidersSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ProvidersSettingsPanel })),
);
