import { lazy, Suspense, type ComponentType } from "react";
import type { ProjectId } from "@ace/contracts";

import { Skeleton } from "../ui/skeleton";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const SETTINGS_PANEL_LOADING_ROW_KEYS = ["general", "chat", "browser", "editor"] as const;

function SettingsPanelLoadingState() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Loading">
        {SETTINGS_PANEL_LOADING_ROW_KEYS.map((rowKey) => (
          <SettingsRow
            key={rowKey}
            title={<Skeleton className="h-4 w-32" />}
            description="Loading settings"
            control={<Skeleton className="h-8 w-full sm:w-44" />}
          />
        ))}
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
