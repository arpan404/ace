import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { browserPermission, requestBrowserPermission } from "@/lib/browser-notify.ts";
import { useNotificationPrefs, type NotificationPrefs } from "./notification-prefs.ts";

const rows: {
  key: Exclude<keyof NotificationPrefs, "browser">;
  title: string;
  description: string;
}[] = [
  {
    key: "needsYou",
    title: "Needs you",
    description:
      "An approval, a question or a plan is waiting. Skipped while you're looking at it.",
  },
  {
    key: "failures",
    title: "Failures",
    description: "The agent stopped with an error and won't continue on its own.",
  },
  {
    key: "automations",
    title: "Automation finished",
    description: "A scheduled or triggered run reports its result.",
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
      {rows.map((row) => (
        <SettingRow
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
      <BrowserRow on={prefs.browser} set={(browser) => update({ browser })} />
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
      title="Browser notifications"
      description={
        blocked
          ? "This browser blocks notifications from ace. Allow them in the site settings first."
          : "While this tab is in the background, a system notification instead of a toast."
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

export function NotificationPreferencesDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Notifications on this device</DialogTitle>
          <DialogDescription>
            Choose what pops up while ace is open. System notifications and quiet hours are in{" "}
            <Link
              to="/settings/notifications"
              onClick={() => props.onOpenChange(false)}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Settings › Notifications
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <NotificationPreferences />
      </DialogContent>
    </Dialog>
  );
}
