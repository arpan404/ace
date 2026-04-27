import { lazy, Suspense, type ComponentType } from "react";

function createLazySettingsPanel(loader: () => Promise<{ default: ComponentType }>) {
  const Panel = lazy(loader);
  const LazySettingsPanel = () => (
    <Suspense fallback={null}>
      <Panel />
    </Suspense>
  );

  return LazySettingsPanel;
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
