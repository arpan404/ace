import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useNotificationPrefs, type NotificationPrefs } from "./notification-prefs.ts";

const rows: { key: keyof NotificationPrefs; title: string; description: string }[] = [
  {
    key: "needsYou",
    title: "When a thread needs you",
    description:
      "An approval, a question or a plan is waiting. Skipped while you're looking at it.",
  },
  {
    key: "failures",
    title: "When a thread fails",
    description: "The agent stopped with an error and won't continue on its own.",
  },
  {
    key: "automations",
    title: "When an automation finishes",
    description: "A scheduled or triggered run reports its result.",
  },
];

/** Which live changes show an in-app toast. Also embeddable in Settings › Notifications. */
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
    </div>
  );
}

export function NotificationPreferencesDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-[min(500px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Toasts on this device</DialogTitle>
          <DialogDescription>
            Choose what pops up while ace is open. Push notifications and quiet hours live in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <NotificationPreferences />
      </DialogContent>
    </Dialog>
  );
}
