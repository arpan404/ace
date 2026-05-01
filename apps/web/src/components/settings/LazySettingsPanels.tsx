import { lazy, Suspense, type ComponentType } from "react";

import { Skeleton } from "../ui/skeleton";
import { SettingsPageContainer, SettingsSection } from "./SettingsPanelPrimitives";

function SettingsPanelLoadingState() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Loading">
        <div className="space-y-0">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="grid gap-2 border-t border-border/45 px-3 py-3 first:border-t-0 sm:px-4 md:grid-cols-[minmax(0,1fr)_10rem] md:items-center md:gap-4"
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

function LazySettingsRoute({ panel: Panel }: { panel: ComponentType }) {
  return (
    <Suspense fallback={<SettingsPanelLoadingState />}>
      <Panel />
    </Suspense>
  );
}

function createLazySettingsPanel(loader: () => Promise<{ default: ComponentType }>) {
  const Panel = lazy(loader);

  return function LazySettingsPanelRoute() {
    return <LazySettingsRoute panel={Panel} />;
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

export const EditorSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.EditorSettingsPanel })),
);

export const GeneralSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.GeneralSettingsPanel })),
);

export const ModelsSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ModelsSettingsPanel })),
);

export const ProvidersSettingsPanelRoute = createLazySettingsPanel(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ProvidersSettingsPanel })),
);
