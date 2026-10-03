import { AdvancedSettings } from "./advanced-page.tsx";
import { AppearanceSettings } from "./appearance-page.tsx";
import { GeneralSettings } from "./general-page.tsx";
import { KeyboardShortcuts } from "./keyboard-page.tsx";
import { NotificationSettings } from "./notifications-page.tsx";
import { ProviderSettings, RediscoverButton } from "./providers-page.tsx";
import { RemoteDevices } from "./remote-page.tsx";
import { SettingsBody } from "./settings-body.tsx";

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

export function ProviderSettingsScreen() {
  return (
    <SettingsBody
      page="Providers & accounts"
      lede="ace uses the CLIs installed on this machine and their own logins. Manage quota and scheduling under Usage & accounts."
      actions={<RediscoverButton />}
    >
      <ProviderSettings />
    </SettingsBody>
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
    <SettingsBody page="Keyboard">
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
