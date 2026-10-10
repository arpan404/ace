import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { browserPermission, requestBrowserPermission } from "@/lib/browser-notify.ts";
import { useNotificationPrefs, type NotificationPrefs } from "./notification-prefs.ts";

const rows: {
  key: Exclude<keyof NotificationPrefs, "browser">;
  title: string;
  description: string;
}[] = [
  {
    key: "agentSays",
    title: "Agent messages",
    description: "Messages addressed to you.",
  },
  {
    key: "needsYou",
    title: "Needs you",
    description: "Approvals, questions and plans.",
  },
  {
    key: "failures",
    title: "Failures",
    description: "An agent stopped with an error.",
  },
  {
    key: "automations",
    title: "Automation finished",
    description: "Results from scheduled runs.",
  },
  {
    key: "limits",
    title: "Usage limits",
    description: "When an account needs attention.",
  },
];

/**
 * Which live changes show an in-app toast, and (in a browser tab) whether a system
 * notification stands in while the tab is in the background. Embeddable in Settings ›
 * Notifications.
 */
export function NotificationPreferences() {
  const [prefs, update] = useNotificationPrefs();
  const id = useId();
  return (
    <div>
      <BrowserRow on={prefs.browser} set={(browser) => update({ browser })} />
      {rows.map((row) => (
        <SettingRow
          density="compact"
          key={row.key}
          title={row.title}
          description={row.description}
          htmlFor={`${id}-${row.key}`}
        >
          <Switch
            id={`${id}-${row.key}`}
            checked={prefs[row.key]}
            onCheckedChange={(checked) => update({ [row.key]: checked })}
          />
        </SettingRow>
      ))}
    </div>
  );
}

/** Browser tabs only: system notifications while the tab is in the background. */
function BrowserRow(props: { on: boolean; set(on: boolean): void }) {
  const [permission, setPermission] = useState(browserPermission);
  const id = useId();
  if (permission === "unsupported") return null;
  const blocked = permission === "denied";
  return (
    <SettingRow
      density="compact"
      title="Show system notifications"
      description={
        blocked
          ? "This browser blocks notifications from ace. Allow them in the site settings first."
          : "While this tab is in the background."
      }
      htmlFor={id}
    >
      <Switch
        id={id}
        checked={props.on && permission === "granted"}
        disabled={blocked}
        onCheckedChange={(checked) => {
          if (!checked) return props.set(false);
          void requestBrowserPermission().then((next) => {
            setPermission(next);
            props.set(next === "granted");
          });
        }}
      />
    </SettingRow>
  );
}
