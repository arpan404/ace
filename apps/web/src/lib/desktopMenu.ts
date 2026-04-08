import type { DesktopMenuAction } from "@ace/contracts";

import type { SettingsSectionPath } from "../components/settings/settingsNavigation";

const SETTINGS_ROUTE_BY_MENU_ACTION = {
  "open-settings": "/settings/general",
  "open-settings-chat": "/settings/chat",
  "open-settings-editor": "/settings/editor",
  "open-settings-browser": "/settings/browser",
  "open-settings-models": "/settings/models",
  "open-settings-providers": "/settings/providers",
  "open-settings-advanced": "/settings/advanced",
  "open-settings-about": "/settings/about",
  "open-settings-archived": "/settings/archived",
} as const satisfies Partial<Record<DesktopMenuAction, SettingsSectionPath>>;

type DesktopSettingsMenuAction = keyof typeof SETTINGS_ROUTE_BY_MENU_ACTION;

function isDesktopSettingsMenuAction(
  action: DesktopMenuAction,
): action is DesktopSettingsMenuAction {
  return action in SETTINGS_ROUTE_BY_MENU_ACTION;
}

export function resolveDesktopMenuSettingsRoute(
  action: DesktopMenuAction,
): SettingsSectionPath | null {
  if (!isDesktopSettingsMenuAction(action)) {
    return null;
  }

  return SETTINGS_ROUTE_BY_MENU_ACTION[action];
}
