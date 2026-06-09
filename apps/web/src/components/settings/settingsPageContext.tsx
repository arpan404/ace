import { createContext, useContext, type ReactNode } from "react";

export type SettingsPageMeta = {
  readonly label: string;
  readonly description: string;
  readonly headerAction?: ReactNode;
};

const SettingsPageContext = createContext<SettingsPageMeta | null>(null);

export function SettingsPageProvider({
  value,
  children,
}: {
  readonly value: SettingsPageMeta;
  readonly children: React.ReactNode;
}) {
  return <SettingsPageContext.Provider value={value}>{children}</SettingsPageContext.Provider>;
}

export function useSettingsPageMeta() {
  return useContext(SettingsPageContext);
}

export const SETTINGS_RESTORED_EVENT = "ace:settings-restored";

export function notifySettingsRestored() {
  window.dispatchEvent(new CustomEvent(SETTINGS_RESTORED_EVENT));
}
